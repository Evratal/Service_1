/**
 * Самопроверка входа через «Яндекс».
 *
 *   node scripts/check-yandex.js
 *
 * Настройки «Яндекса» задаются здесь же (клиент, секрет, адрес возврата),
 * а два обращения к сервису (обмен кода на токен и чтение профиля) заменяются
 * заглушкой поверх настоящего fetch. Так проверяется вся наша логика — от
 * перенаправления до выдачи собственного токена сессии — без реальной сети
 * и без настоящих учётных данных.
 *
 * База — в памяти, рабочая база и настоящий «Яндекс» не затрагиваются.
 */

// Переменные окружения выставляются ДО импорта конфигурации: она читает их
// один раз при загрузке, поэтому обычный import выше по файлу не подошёл бы.
process.env.YANDEX_CLIENT_ID = 'test-client-id';
process.env.YANDEX_CLIENT_SECRET = 'test-client-secret';
process.env.YANDEX_REDIRECT_URI = 'https://studio.example/api/auth/yandex/callback';

const { createServer } = await import('node:http');
const { once } = await import('node:events');
const { createApp } = await import('../src/app.js');
const { freshTestDb, seedFixtures } = await import('./fixtures.js');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  OK    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// Заглушка «Яндекса»: перехватываем только два его адреса, остальные запросы
// (в том числе наши собственные) уходят в настоящий fetch.
const realFetch = globalThis.fetch;
let profile = null;
let tokenCalls = 0;
let profileCalls = 0;
let failNextToken = false;

globalThis.fetch = async (url, options = {}) => {
  const target = String(url);
  if (target.startsWith('https://oauth.yandex.ru/token')) {
    tokenCalls += 1;
    if (failNextToken) {
      failNextToken = false;
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    }
    return new Response(JSON.stringify({ access_token: 'ya-access-token' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  if (target.startsWith('https://login.yandex.ru/info')) {
    profileCalls += 1;
    return new Response(JSON.stringify(profile), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return realFetch(url, options);
};

async function main() {
  const db = freshTestDb();
  await seedFixtures(db);

  const app = createApp({ db, publicDir: 'public' });
  const server = createServer(app.handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  // redirect: 'manual' — сами читаем заголовок Location, а не идём по нему.
  const visit = (path) => realFetch(`${base}${path}`, { redirect: 'manual' });
  const locationOf = (response) => response.headers.get('location') ?? '';
  const loginParams = (location) => new URLSearchParams(new URL(location).hash.split('?')[1] ?? '');

  /** Достаёт свежий state из начала входа. */
  async function freshState() {
    const authorize = await visit('/api/auth/yandex');
    const location = locationOf(authorize);
    return {
      status: authorize.status,
      location,
      state: new URL(location).searchParams.get('state')
    };
  }

  section('Начало входа');

  const start = await freshState();
  check('маршрут входа отвечает перенаправлением', start.status === 302, `код ${start.status}`);
  check('перенаправление ведёт на страницу «Яндекса»', start.location.startsWith('https://oauth.yandex.ru/authorize?'));
  const startParams = new URL(start.location).searchParams;
  check('в адресе передан наш client_id', startParams.get('client_id') === 'test-client-id');
  check('в адресе передан наш redirect_uri', startParams.get('redirect_uri') === 'https://studio.example/api/auth/yandex/callback');
  check('запрошен код авторизации', startParams.get('response_type') === 'code');
  check('передан одноразовый state', Boolean(start.state));

  section('Возврат от «Яндекса»: отказы и защита');

  const denied = await visit('/api/auth/yandex/callback?error=access_denied&error_description=user+denied');
  check('отказ пользователя ведёт назад на вход', denied.status === 302);
  check('в адресе отмечен отказ', loginParams(locationOf(denied)).get('yandex') === 'denied');

  const badState = await visit(`/api/auth/yandex/callback?code=abc&state=nepoddelnyj`);
  check('чужой state отклонён', loginParams(locationOf(badState)).get('yandex') === 'error');

  const noCode = await visit(`/api/auth/yandex/callback?state=${encodeURIComponent(start.state)}`);
  check('без кода вход отклонён', loginParams(locationOf(noCode)).get('yandex') === 'error');

  let reusedState = await freshState();
  await visit(`/api/auth/yandex/callback?code=first&state=${encodeURIComponent(reusedState.state)}`);
  const twice = await visit(`/api/auth/yandex/callback?code=first&state=${encodeURIComponent(reusedState.state)}`);
  check('state нельзя использовать дважды', loginParams(locationOf(twice)).get('yandex') === 'error');

  section('Возврат от «Яндекса»: успешный вход');

  profile = { id: '100500', default_email: 'novyj@example.com', real_name: 'Новый Клиент' };
  const goodState = await freshState();
  const tokensBefore = tokenCalls;
  const login = await visit(`/api/auth/yandex/callback?code=code1&state=${encodeURIComponent(goodState.state)}`);
  const loginParamsResult = loginParams(locationOf(login));
  check('вход завершился успехом', loginParamsResult.get('yandex') === 'ok');
  check('код обменян на токен у «Яндекса»', tokenCalls === tokensBefore + 1);
  const sessionToken = loginParamsResult.get('token');
  check('выдан собственный токен сессии', Boolean(sessionToken) && sessionToken.length > 20);

  const me = await realFetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${sessionToken}` } });
  const meJson = await me.json();
  check('токен открывает профиль', me.status === 200, `код ${me.status}`);
  check('профиль содержит почту из «Яндекса»', meJson?.user?.email === 'novyj@example.com');
  check('имя взято из «Яндекса»', meJson?.user?.name === 'Новый Клиент');
  check('новому пользователю назначена роль клиента', (meJson?.user?.roles ?? []).includes('client'));

  const firstId = meJson?.user?.id;

  section('Повторный вход и привязка к аккаунту');

  const repeatState = await freshState();
  const repeat = await visit(`/api/auth/yandex/callback?code=code2&state=${encodeURIComponent(repeatState.state)}`);
  const repeatMe = await realFetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${loginParams(locationOf(repeat)).get('token')}` }
  });
  const repeatJson = await repeatMe.json();
  check('повторный вход заводит того же пользователя', repeatJson?.user?.id === firstId);

  // Существующий клиент входит через «Яндекс» — аккаунт должен связаться, а не
  // задвоиться.
  profile = { id: '200200', default_email: 'anna@example.com', real_name: 'Анна Крылова' };
  const linkState = await freshState();
  const link = await visit(`/api/auth/yandex/callback?code=code3&state=${encodeURIComponent(linkState.state)}`);
  const linkMe = await realFetch(`${base}/api/auth/me`, {
    headers: { Authorization: `Bearer ${loginParams(locationOf(link)).get('token')}` }
  });
  const linkJson = await linkMe.json();
  check('вход по существующей почте не создаёт дубль', linkJson?.user?.email === 'anna@example.com');
  check('привязка сохранила роль мастера', (linkJson?.user?.roles ?? []).includes('master'));

  section('Заблокированный аккаунт');

  const db2 = freshTestDb();
  await seedFixtures(db2);
  db2.prepare('UPDATE users SET is_active = 0 WHERE email = ?').run('oleg@example.com');
  const app2 = createApp({ db: db2, publicDir: 'public' });
  const server2 = createServer(app2.handle);
  server2.listen(0, '127.0.0.1');
  await once(server2, 'listening');
  const base2 = `http://127.0.0.1:${server2.address().port}`;

  profile = { id: '300300', default_email: 'oleg@example.com', real_name: 'Олег Тимофеев' };
  const blockStart = await realFetch(`${base2}/api/auth/yandex`, { redirect: 'manual' });
  const blockState = new URL(locationOf(blockStart)).searchParams.get('state');
  const blocked = await realFetch(
    `${base2}/api/auth/yandex/callback?code=x&state=${encodeURIComponent(blockState)}`,
    { redirect: 'manual' }
  );
  check('заблокированный аккаунт не пускается', loginParams(locationOf(blocked)).get('yandex') === 'blocked');
  check('заблокированному аккаунту токен не выдаётся', !loginParams(locationOf(blocked)).get('token'));

  section('Сбой «Яндекса»');

  failNextToken = true;
  profile = { id: '400400', default_email: 'sboj@example.com', real_name: 'Сбой' };
  const failState = await freshState();
  const failedLogin = await visit(`/api/auth/yandex/callback?code=y&state=${encodeURIComponent(failState.state)}`);
  check('ошибка обмена кода не ломает страницу', failedLogin.status === 302);
  check('ошибка показывается на экране входа', loginParams(locationOf(failedLogin)).get('yandex') === 'error');

  server.close();
  server2.close();

  console.log(`\nИтог: успешно ${passed}, ошибок ${failed}.`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
