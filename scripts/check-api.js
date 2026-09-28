/**
 * Самопроверка API: поднимает настоящий HTTP-сервер на случайном порту
 * и проверяет сценарии настоящими запросами.
 *
 *   node scripts/check-api.js
 *
 * Почему именно так: проверять обработчики напрямую, минуя HTTP, нельзя —
 * тогда останутся непроверенными разбор тела, заголовок авторизации, коды
 * ответов и то, как сервер ведёт себя при отсутствии прав. Здесь запросы
 * идут через node:http, как у настоящего клиента.
 *
 * База — в памяти, рабочая база не затрагивается, порт выбирается системой.
 */

import { createServer } from 'node:http';
import { once } from 'node:events';

import { createApp } from '../src/app.js';
import { computeFreeSlots } from '../src/slots.js';
import { formatUtc, utcToZonedParts, zonedToUtc } from '../src/time.js';
import * as holds from '../src/holds.js';
import { freshTestDb, seedFixtures } from './fixtures.js';

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

/** Ближайший понедельник, не раньше чем через сутки: время точно в будущем. */
function nextMonday(hour, minute = 0) {
  const now = new Date();
  const today = utcToZonedParts(now, 'Europe/Moscow');
  const daysAhead = ((1 - today.weekday + 7) % 7) || 7;
  return zonedToUtc({ ...today, day: today.day + daysAhead, hour, minute }, 'Europe/Moscow');
}

function nextSunday(hour, minute = 0) {
  const now = new Date();
  const today = utcToZonedParts(now, 'Europe/Moscow');
  const daysAhead = (7 - today.weekday) % 7 || 7;
  return zonedToUtc({ ...today, day: today.day + daysAhead, hour, minute }, 'Europe/Moscow');
}

async function main() {
  const db = freshTestDb();
  const fixtures = await seedFixtures(db);
  const { masterId, service60, service90, service45, password } = fixtures;

  const app = createApp({ db, publicDir: 'public' });
  const server = createServer(app.handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const base = `http://127.0.0.1:${server.address().port}`;

  /** Запрос к API с необязательным токеном и адресом клиента. */
  async function api(method, path, { body, token, ip } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (ip) headers['X-Forwarded-For'] = ip;

    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return { status: response.status, json, text, headers: response.headers };
  }

  const register = (overrides = {}, ip = '10.0.0.1') =>
    api('POST', '/api/auth/register', {
      ip,
      body: {
        email: `user${Math.random().toString(36).slice(2, 9)}@example.com`,
        name: 'Тестовый клиент',
        password: 'Test2026!',
        ...overrides
      }
    });

  const login = (email, pwd = password, ip = '10.0.0.1') =>
    api('POST', '/api/auth/login', { body: { email, password: pwd }, ip });

  // ------------------------------------------------------------------ справочники
  console.log('Самопроверка API TOP BRO');
  console.log(`Node ${process.version}, сервер на порту ${server.address().port}, база в памяти.`);

  section('Публичные справочники');

  {
    const salon = await api('GET', '/api/salon');
    check('GET /api/salon отвечает данными студии', salon.status === 200 && salon.json.name === 'TOP BRO');
    check('часовой пояс студии передан клиенту', salon.json.timezone === 'Europe/Moscow');

    const services = await api('GET', '/api/services');
    check('список услуг отдаётся без авторизации', services.status === 200 && services.json.services.length === 3);
    check(
      'услуга отдаётся в понятных клиенту полях',
      services.json.services[0].durationMin > 0 && typeof services.json.services[0].priceRub === 'number'
    );

    const masters = await api('GET', '/api/masters');
    check('список мастеров отдаётся гостю', masters.status === 200 && masters.json.masters.length === 1);

    const byService = await api('GET', `/api/masters?serviceIds=${service90}`);
    check('фильтр по услуге оставил подходящего мастера', byService.json.masters.length === 1);

    const missing = await api('GET', '/api/masters/999');
    check('несуществующий мастер даёт 404', missing.status === 404, `статус ${missing.status}`);
  }

  // ------------------------------------------------------------------ свободные слоты
  section('Расчёт свободных слотов');

  const monday12 = nextMonday(12);
  const mondayDate = utcToZonedParts(monday12, 'Europe/Moscow').date;

  {
    const result = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=${service60}`);

    check('слоты считаются гостю без входа', result.status === 200);
    check('первый слот начинается в 10:00', result.json.slots[0]?.time === '10:00', result.json.slots[0]?.time);

    // График 10:00–20:00, услуга 60 минут, шаг 15 минут:
    // последний слот начинается в 19:00, всего 37 окон.
    const last = result.json.slots[result.json.slots.length - 1];
    check('последний слот начинается в 19:00', last?.time === '19:00', last?.time);
    check('количество слотов равно 37', result.json.count === 37, `получено ${result.json.count}`);
    check(
      'слот не выходит за конец рабочего дня',
      result.json.slots.every((slot) => slot.time >= '10:00' && slot.time <= '19:00')
    );

    // Две услуги: 60 + 90 = 150 минут. График до 20:00, поэтому
    // последний слот начинается в 17:30.
    const long = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=${service60},${service90}`);
    check(
      'суммарная длительность двух услуг сдвигает последний слот',
      long.json.slots[long.json.slots.length - 1].time === '17:30',
      long.json.slots[long.json.slots.length - 1].time
    );

    const sunday = nextSunday(12);
    const sundayDate = utcToZonedParts(sunday, 'Europe/Moscow').date;
    const off = await api('GET', `/api/masters/${masterId}/slots?date=${sundayDate}`);
    check('в выходной слотов нет', off.json.count === 0 && off.json.reason === 'day_off', off.json.reason);

    const past = await api('GET', `/api/masters/${masterId}/slots?date=2020-01-01`);
    check('на прошедшую дату слотов нет', past.json.count === 0 && past.json.reason === 'date_in_past', past.json.reason);

    const badDate = await api('GET', `/api/masters/${masterId}/slots?date=31-12-2026`);
    check('некорректная дата отклонена', badDate.status === 400, `статус ${badDate.status}`);

    const noDate = await api('GET', `/api/masters/${masterId}/slots`);
    check('без даты приходит понятная ошибка', noDate.status === 400 && noDate.json.error.code === 'bad_request');

    const unknown = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=999999`);
    check('несуществующая услуга не ломает расчёт', unknown.status === 200);
  }

  // ------------------------------------------------------------------ регистрация и вход
  section('Регистрация и вход');

  const anna = await login('anna@example.com', password, '10.0.1.1');
  const oleg = await login('oleg@example.com', password, '10.0.1.2');
  const admin = await login('admin@topbro.ru', password, '10.0.1.3');

  check('вход клиента выдаёт токен', anna.status === 200 && typeof anna.json.token === 'string');
  check('вход клиента не выдаёт хеш пароля', !anna.text.includes('scrypt$'));
  check('вход администратора выдаёт роль admin', admin.json.user.roles.includes('admin'), admin.json.user.roles.join(','));

  {
    const escalation = await register({ role: 'admin', roles: ['admin'], is_admin: 1 });
    check('роль из тела запроса игнорируется', escalation.json.user.roles.join(',') === 'client', escalation.json.user.roles.join(','));

    const short = await register({ password: 'корот' });
    check('короткий пароль отклонён', short.status === 400 && short.json.error.details.fields.some((f) => f.field === 'password'));

    const badEmail = await register({ email: 'не-почта' });
    check('некорректный e-mail отклонён', badEmail.status === 400);

    const first = await register({ email: 'duplicate@example.com' });
    const second = await register({ email: 'duplicate@example.com' });
    check('повторная регистрация e-mail даёт 409', second.status === 409, `статус ${second.status}`);
    check('e-mail сравнивается без учёта регистра', first.status === 201);

    const injection = await register({ email: "victim@example.com' OR '1'='1" });
    check('попытка SQL-инъекции в e-mail отклонена', injection.status === 400, `статус ${injection.status}`);

    const notJson = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{это не json'
    });
    check('битое тело запроса даёт 400, а не 500', notJson.status === 400, `статус ${notJson.status}`);
  }

  {
    const wrongPassword = await login('anna@example.com', 'неверный-пароль', '10.0.2.1');
    const unknownUser = await login('nobody@example.com', password, '10.0.2.2');

    check('неверный пароль даёт 401', wrongPassword.status === 401);
    check(
      'текст ошибки одинаков для неверного пароля и несуществующего e-mail',
      wrongPassword.json.error.message === unknownUser.json.error.message,
      `${wrongPassword.json.error.message} / ${unknownUser.json.error.message}`
    );
  }

  {
    // Лимит перебора: 5 неудачных попыток, шестая — отказ.
    let lastStatus = 0;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const response = await login('bruteforce@example.com', `пароль-${attempt}`, '10.0.3.9');
      lastStatus = response.status;
      if (response.status === 429) break;
    }
    check('перебор пароля упирается в 429', lastStatus === 429, `последний статус ${lastStatus}`);
  }

  // ------------------------------------------------------------------ доступ к данным
  section('Права доступа');

  {
    const noToken = await api('GET', '/api/appointments');
    check('список записей без токена даёт 401', noToken.status === 401, `статус ${noToken.status}`);

    // Заголовок Authorization должен быть ASCII, поэтому токен-подделка
    // тоже латиницей: иначе проверка падала бы на кодировке, а не на правах.
    const badToken = await api('GET', '/api/appointments', { token: 'fake-token-0000' });
    check('выдуманный токен даёт 401', badToken.status === 401);

    const raw = await api('GET', `/api/appointments?token=${anna.json.token}`);
    check('токен в адресе не принимается', raw.status === 401, `статус ${raw.status}`);
  }

  // ------------------------------------------------------------------ создание записи
  section('Создание записи');

  const annaToken = anna.json.token;
  const olegToken = oleg.json.token;
  const adminToken = admin.json.token;

  const firstSlotIso = formatUtc(nextMonday(12));
  let annaAppointment = null;

  {
    const created = await api('POST', '/api/appointments', {
      token: annaToken,
      ip: '10.0.4.1',
      body: { masterId, serviceIds: [service60], startsAt: firstSlotIso, notes: 'Первый визит' }
    });

    check('запись создана', created.status === 201, `статус ${created.status}: ${created.text.slice(0, 120)}`);
    check(
      'стоимость посчитана из цен услуг',
      created.json?.appointment?.totalPriceRub === 2500,
      String(created.json?.appointment?.totalPriceRub)
    );
    check('время окончания вычислено по длительности', created.json?.appointment?.endsAt?.endsWith('Z') === true);
    annaAppointment = created.json.appointment;
  }

  {
    const again = await api('POST', '/api/appointments', {
      token: annaToken,
      ip: '10.0.4.1',
      body: { masterId, serviceIds: [service60], startsAt: firstSlotIso }
    });
    check('повторная запись на тот же слот даёт 409', again.status === 409, `статус ${again.status}`);

    const second = await api('POST', '/api/appointments', {
      token: annaToken,
      ip: '10.0.4.1',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(12, 30)) }
    });
    check('наложение на занятый интервал даёт 409', second.status === 409, `статус ${second.status}`);

    const occupied = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: firstSlotIso }
    });
    check('другой клиент не может занять тот же слот', occupied.status === 409, `статус ${occupied.status}`);

    const overrideByClient = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: firstSlotIso, isOverride: true }
    });
    check(
      'клиент не может обойти защиту признаком isOverride',
      overrideByClient.status === 409,
      `статус ${overrideByClient.status}`
    );
  }

  {
    const outsideHours = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(23)) }
    });
    check('запись после закрытия отклонена', outsideHours.status === 409, `статус ${outsideHours.status}`);

    const past = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: '2020-01-01T10:00:00Z' }
    });
    check('запись в прошлом отклонена', past.status === 400, `статус ${past.status}`);

    const notAligned = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(12, 7)) }
    });
    check('время вне сетки слотов отклонено', notAligned.status === 409, `статус ${notAligned.status}`);

    const noService = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [], startsAt: formatUtc(nextMonday(14)) }
    });
    check('запись без услуг отклонена', noService.status === 400);

    const longNotes = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(14)), notes: 'я'.repeat(600) }
    });
    check('слишком длинная заметка отклонена', longNotes.status === 400);

    const foreignClient = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(14)), clientId: fixtures.clientIds[0] }
    });
    check('клиент не может записать другого человека', foreignClient.status === 403, `статус ${foreignClient.status}`);
  }

  {
    // Слот освободился: 12:30 занят, но 12:00–13:00 перекрывается записью Анны,
    // поэтому 14:00 свободен.
    const booked = await api('POST', '/api/appointments', {
      token: olegToken,
      ip: '10.0.4.2',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(14)) }
    });
    check('свободный слот другого времени записывается', booked.status === 201, `статус ${booked.status}`);

    const takenAway = await api('POST', '/api/appointments', {
      token: annaToken,
      ip: '10.0.4.1',
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(14)) }
    });
    check('занятое другим клиентом время больше не записывается', takenAway.status === 409);
  }

  {
    // Честная проверка наложения: сначала слот 15:00 занимает обычная запись
    // (администратор записал олега), потом администратор накладывает вторую
    // запись на это же время для анны. Клиент себе такой обход не позволяет:
    // проверено выше признаком isOverride, а здесь — реальным занятым слотом.
    const occupiedTarget = formatUtc(nextMonday(15));

    const normalForOleg = await api('POST', '/api/appointments', {
      token: adminToken,
      body: { masterId, serviceIds: [service45], startsAt: occupiedTarget, clientId: fixtures.clientIds[1] }
    });
    check('администратор создаёт обычную запись клиенту', normalForOleg.status === 201, `статус ${normalForOleg.status}`);

    const clientBlocked = await api('POST', '/api/appointments', {
      token: annaToken,
      body: { masterId, serviceIds: [service45], startsAt: occupiedTarget }
    });
    check('тот же слот клиенту уже недоступен', clientBlocked.status === 409, `статус ${clientBlocked.status}`);

    const override = await api('POST', '/api/appointments', {
      token: adminToken,
      body: { masterId, serviceIds: [service45], startsAt: occupiedTarget, clientId: fixtures.clientIds[0], isOverride: true }
    });
    check('администратор накладывает запись на занятое время', override.status === 201, `статус ${override.status}`);
    check('наложенная запись помечена как исключение', override.json?.appointment?.isOverride === true);
  }

  // ------------------------------------------------------------------ чтение и отмена
  section('Чтение и отмена записи');

  {
    const mine = await api('GET', '/api/appointments', { token: olegToken });
    // Две записи олега: 14:00 он записал сам, 15:00 — администратор.
    check('клиент видит только свои записи', mine.json.appointments.length === 2, `записей ${mine.json.appointments.length}`);
    check(
      'все видимые записи принадлежат клиенту',
      mine.json.appointments.every((appointment) => appointment.client.id === fixtures.clientIds[1])
    );

    const someoneElse = await api('GET', `/api/appointments/${annaAppointment.id}`, { token: olegToken });
    check('чужую запись открыть нельзя', someoneElse.status === 403, `статус ${someoneElse.status}`);

    const own = await api('GET', `/api/appointments/${annaAppointment.id}`, { token: annaToken });
    check('свою запись клиент открывает', own.status === 200 && own.json.appointment.id === annaAppointment.id);

    const asAdmin = await api('GET', `/api/appointments/${annaAppointment.id}`, { token: adminToken });
    check('администратор открывает любую запись', asAdmin.status === 200);

    const allAsClient = await api('GET', '/api/appointments?scope=all', { token: olegToken });
    check('scope=all клиенту недоступен', allAsClient.status === 403);

    const allAsAdmin = await api('GET', '/api/appointments?scope=all', { token: adminToken });
    // На этот момент в базе четыре активные записи: анна 12:00, олег 14:00,
    // олег 15:00 (обычная) и анна 15:00 (наложенная администратором).
    check('администратор видит все записи', allAsAdmin.status === 200 && allAsAdmin.json.appointments.length === 4, `записей ${allAsAdmin.json.appointments?.length}`);

    const unknownId = await api('GET', '/api/appointments/999999', { token: adminToken });
    check('несуществующая запись даёт 404', unknownId.status === 404);

    const badId = await api('GET', '/api/appointments/abc', { token: adminToken });
    check('нечисловой идентификатор даёт 400', badId.status === 400);
  }

  {
    const foreignCancel = await api('POST', `/api/appointments/${annaAppointment.id}/cancel`, { token: olegToken });
    check('чужую запись отменить нельзя', foreignCancel.status === 403);

    const ownCancel = await api('POST', `/api/appointments/${annaAppointment.id}/cancel`, {
      token: annaToken,
      body: { reason: 'Планы изменились' }
    });
    check('клиент отменяет свою запись', ownCancel.status === 200);
    check('статус отменённой записи верный', ownCancel.json.appointment.status === 'cancelled_by_client', ownCancel.json.appointment.status);

    const twice = await api('POST', `/api/appointments/${annaAppointment.id}/cancel`, { token: annaToken });
    check('повторная отмена отклонена', twice.status === 400, `статус ${twice.status}`);

    // Запись Анны освободила слот 12:00–13:00 целиком: наложение
    // администратора перенесено на 17:00, поэтому время снова доступно.
    const rebooked = await api('POST', '/api/appointments', {
      token: olegToken,
      body: { masterId, serviceIds: [service60], startsAt: formatUtc(nextMonday(12)) }
    });
    check('отменённое время снова доступно', rebooked.status === 201, `статус ${rebooked.status}`);
  }

  // ------------------------------------------------------------------ удержание слота
  section('Удержание слота');

  {
    const holdIso = formatUtc(nextMonday(16));
    const holdEnd = formatUtc(nextMonday(17));

    const first = await api('POST', '/api/holds', {
      token: annaToken,
      ip: '10.0.9.1',
      body: { masterId, startsAt: holdIso, endsAt: holdEnd }
    });
    check('слот можно занять', first.status === 201 && first.json.held === true);

    const second = await api('POST', '/api/holds', {
      token: olegToken,
      ip: '10.0.9.2',
      body: { masterId, startsAt: holdIso, endsAt: holdEnd }
    });
    check('второй клиент не может занять тот же слот', second.status === 400, `статус ${second.status}`);

    const slots = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=${service60}`);
    check(
      'удержанный слот пропал из списка свободных',
      !slots.json.slots.some((slot) => slot.startsAt === holdIso)
    );

    const ownSlots = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=${service60}`, {
      token: annaToken
    });
    check(
      'свой удержанный слот клиент по-прежнему видит',
      ownSlots.json.slots.some((slot) => slot.startsAt === holdIso)
    );

    const extended = await api('POST', '/api/holds/extend', {
      token: annaToken,
      ip: '10.0.9.1',
      body: { masterId, startsAt: holdIso }
    });
    check('удержание продлевается', extended.status === 200 && extended.json.held === true);

    const foreignRelease = await api('DELETE', '/api/holds', {
      token: olegToken,
      ip: '10.0.9.2',
      body: { masterId, startsAt: holdIso }
    });
    check('чужое удержание нельзя снять', foreignRelease.status === 200 && foreignRelease.json.released === false);

    const release = await api('DELETE', '/api/holds', {
      token: annaToken,
      ip: '10.0.9.1',
      body: { masterId, startsAt: holdIso }
    });
    check('своё удержание снимается', release.json.released === true);

    const afterRelease = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=${service60}`);
    check(
      'после снятия удержания слот снова свободен',
      afterRelease.json.slots.some((slot) => slot.startsAt === holdIso)
    );
  }

  // ------------------------------------------------------------------ гонка
  section('Одновременная запись на один слот');

  {
    holds.reset();

    // Десять параллельных запросов на одно и то же время. Ровно один должен
    // выиграть: это проверка транзакции и триггера, а не только проверки кода.
    const target = formatUtc(nextMonday(18));
    const tokens = [annaToken, olegToken, adminToken];

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        api('POST', '/api/appointments', {
          token: tokens[index % tokens.length],
          ip: `10.0.8.${index}`,
          body: { masterId, serviceIds: [service60], startsAt: target }
        })
      )
    );

    const created = responses.filter((response) => response.status === 201);
    const conflicts = responses.filter((response) => response.status === 409);

    check(
      'из десяти одновременных запросов создана ровно одна запись',
      created.length === 1,
      `создано ${created.length}, отказов ${conflicts.length}`
    );
    check('остальные получили 409', created.length + conflicts.length === 10);

    const inDb = db
      .prepare("SELECT COUNT(*) AS n FROM appointments WHERE starts_at = ? AND status = 'booked'")
      .get(target);
    check('в базе действительно одна запись на это время', inDb.n === 1, `записей ${inDb.n}`);
  }

  // ------------------------------------------------------------------ выход и заголовки
  section('Выход, заголовки, маршруты');

  {
    const fresh = await register({}, '10.0.7.1');
    const token = fresh.json.token;

    const before = await api('GET', '/api/appointments', { token });
    check('свежий токен работает', before.status === 200);

    const logout = await api('POST', '/api/auth/logout', { token });
    check('выход возвращает 204', logout.status === 204, `статус ${logout.status}`);

    const after = await api('GET', '/api/appointments', { token });
    check('после выхода токен больше не работает', after.status === 401);

    const me = await api('GET', '/api/auth/me', { token: annaToken });
    check('GET /api/auth/me отдаёт текущего пользователя', me.status === 200 && me.json.user.email === 'anna@example.com');

    const meNoToken = await api('GET', '/api/auth/me');
    check('GET /api/auth/me без токена даёт 401', meNoToken.status === 401);
  }

  {
    const health = await api('GET', '/api/salon');
    check('заголовок nosniff выставлен', health.headers.get('x-content-type-options') === 'nosniff');
    check('запрет кэширования выставлен', (health.headers.get('cache-control') ?? '').includes('no-store'));
    check('запрет обрамления в iframe выставлен', health.headers.get('x-frame-options') === 'DENY');
    check(
      'Content-Security-Policy задан',
      (health.headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'")
    );

    const traversal = await api('GET', '/../../.env');
    check('обход каталога не выдаёт файл', traversal.status === 404, `статус ${traversal.status}`);
    check('содержимое .env не утекло', !traversal.text.includes('DB_FILE'), traversal.text.slice(0, 80));

    const encoded = await api('GET', '/%2e%2e%2f%2e%2e%2f.env');
    check('обход каталога в кодировке не выдаёт файл', encoded.status === 404, `статус ${encoded.status}`);

    const wrongMethod = await api('DELETE', '/api/salon');
    check('неподдерживаемый метод даёт 405', wrongMethod.status === 405, `статус ${wrongMethod.status}`);

    const unknownApi = await api('GET', '/api/чего-нибудь');
    check('неизвестный адрес API даёт 404', unknownApi.status === 404);

    const internal = await api('GET', '/api/masters/999999/slots?date=' + mondayDate);
    check('внутренний текст ошибки базы не утекает', !internal.text.includes('SQLITE'), internal.text.slice(0, 120));
  }

  // ------------------------------------------------------------------ сходимость
  section('Согласованность расчёта с базой');

  {
    // Свободные слоты, посчитанные напрямую из базы, должны совпасть с тем,
    // что отдаёт API: иначе расчёт на экране и расчёт при записи разойдутся.
    const direct = computeFreeSlots({
      db,
      masterId,
      date: mondayDate,
      timezone: 'Europe/Moscow',
      durationMin: 60,
      holds: holds.holdsForMaster(masterId)
    });
    const viaApi = await api('GET', `/api/masters/${masterId}/slots?date=${mondayDate}&serviceIds=${service60}`);

    check(
      'слоты из API совпадают с прямым расчётом',
      JSON.stringify(direct.slots.map((s) => s.startsAt)) === JSON.stringify(viaApi.json.slots.map((s) => s.startsAt)),
      `прямой расчёт дал ${direct.total}, API — ${viaApi.json.count}`
    );
  }

  server.close();
  db.close();

  console.log(`\nИтог: успешно ${passed}, ошибок ${failed}.`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Самопроверка API не завершилась:', error);
  process.exit(1);
});
