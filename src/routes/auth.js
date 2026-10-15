/**
 * Маршруты регистрации, входа и выхода.
 *
 * Здесь три правила безопасности, которые проверяются в первую очередь:
 *
 *   1. Роль назначает сервер. Тело запроса может содержать что угодно —
 *      поле role из него просто не читается.
 *   2. Ответ на неверный e-mail и на неверный пароль одинаковый. Иначе
 *      по тексту ошибки можно перебрать список зарегистрированных.
 *   3. Проверка пароля занимает одинаковое время в обоих случаях: для
 *      несуществующего e-mail всё равно считается хеш, иначе по скорости
 *      ответа видно, существует ли аккаунт.
 */

import { randomBytes } from 'node:crypto';

import { HttpError, unauthorized } from '../errors.js';
import { validate } from '../validate.js';
import { hashPassword, verifyPassword } from '../security.js';
import { extractToken, issueToken, loadSession, revokeToken } from '../auth.js';
import { config } from '../config.js';
import { realClientIp } from '../client-ip.js';
import { buildAuthorizeUrl, exchangeCode, fetchUserProfile, yandexEnabled } from '../yandex.js';
import {
  assertLoginAllowed,
  assertRegisterAllowed,
  clearFailedAttempts,
  createUser,
  findByEmail,
  logAttempt,
  logRegisterAttempt,
  masterIdForUser,
  publicUser,
  rolesOf,
  upsertExternalUser
} from '../repo/users.js';

const REGISTER_RULES = {
  email: { type: 'email', required: true },
  name: { type: 'string', required: true, min: 2, max: 120 },
  phone: { type: 'string', required: false, max: 32, nullable: true },
  password: { type: 'password', required: true }
};

const LOGIN_RULES = {
  email: { type: 'email', required: true },
  password: { type: 'string', required: true, max: 200 }
};

const SAME_MESSAGE = 'Неверный e-mail или пароль.';

/**
 * Хеш для сравнения времени: считается один раз, чтобы ответ на запрос
 * с несуществующим e-mail занимал столько же, сколько проверка настоящего
 * пароля. Хранить настоящий пароль не нужно — важен только сам факт расчёта.
 */
let decoyHash = null;
async function getDecoyHash() {
  if (decoyHash === null) {
    decoyHash = await hashPassword('пароль-который-никто-не-подберёт-0');
  }
  return decoyHash;
}

function clientIp(req) {
  return realClientIp(req);
}

/**
 * Одноразовые значения state для входа через «Яндекс».
 *
 * state защищает от подмены запроса (CSRF): «Яндекс» возвращает его обратно,
 * и мы проверяем, что именно этот браузер начинал вход. Хранятся в памяти
 * процесса и живут недолго — после использования или по истечении срока
 * удаляются. Для одного процесса этого достаточно; при нескольких процессах
 * понадобилось бы общее хранилище.
 */
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const oauthStates = new Map();

function issueOauthState() {
  const state = randomBytes(16).toString('base64url');
  oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
  return state;
}

function consumeOauthState(state) {
  if (typeof state !== 'string' || state.length === 0) return false;
  const expiresAt = oauthStates.get(state);
  oauthStates.delete(state);
  return expiresAt !== undefined && expiresAt > Date.now();
}

/** Базовый адрес сайта (схема + хост) — из адреса возврата «Яндекса». */
function appBase() {
  try {
    return new URL(config.yandex.redirectUri).origin;
  } catch {
    return '';
  }
}

export function registerAuthRoutes(router) {
  router.post('/api/auth/register', async ({ req, res, db, body }) => {
    const ip = clientIp(req);

    try {
      const data = validate(body, REGISTER_RULES);

      assertRegisterAllowed(db, ip);

      const passwordHash = await hashPassword(data.password);
      const user = createUser(db, {
        email: data.email,
        passwordHash,
        name: data.name,
        phone: data.phone ?? null
        // Роль не читается из тела запроса. Новый пользователь — клиент.
      });

      const roles = rolesOf(db, user.id);
      const token = issueToken(db, user.id);
      logAttempt(db, { email: user.email, ip, succeeded: true });

      return {
        status: 201,
        payload: {
          user: publicUser(user, roles),
          token,
          tokenTtlHours: config.tokenTtlHours
        }
      };
    } catch (error) {
      // Любая неудачная регистрация считается попыткой: так счётчик в
      // assertRegisterAllowed видит реальный объём запросов с одного адреса.
      logRegisterAttempt(db, ip ?? null);
      throw error;
    }
  });

  router.post('/api/auth/login', async ({ req, db, body }) => {
    const data = validate(body, LOGIN_RULES);
    const email = data.email.toLowerCase();
    const ip = clientIp(req);

    // Лимит проверяется до сверки пароля: иначе перебор всё равно
    // нагружал бы базу сравнениями.
    assertLoginAllowed(db, email);

    const user = findByEmail(db, email);
    // У аккаунтов, заведённых через внешний сервис, пароля нет (пустая строка).
    // Для них считаем заведомо ложный хеш: иначе вход по такому e-mail отвечал
    // бы заметно быстрее и по времени ответа можно было бы отличить аккаунты.
    const hash = user && user.password_hash ? user.password_hash : await getDecoyHash();
    const passwordOk = await verifyPassword(data.password, hash);

    // Один и тот же текст ошибки и одинаковый код ответа для обоих случаев.
    if (!user || !passwordOk) {
      logAttempt(db, { email, ip, succeeded: false });
      throw unauthorized(SAME_MESSAGE);
    }

    if (user.is_active !== 1) {
      logAttempt(db, { email, ip, succeeded: false });
      throw unauthorized('Аккаунт заблокирован. Обратитесь в студию.');
    }

    clearFailedAttempts(db, email);
    logAttempt(db, { email, ip, succeeded: true });

    const roles = rolesOf(db, user.id);
    const token = issueToken(db, user.id);

    return {
      payload: {
        user: publicUser(user, roles, masterIdForUser(db, user.id)),
        token,
        tokenTtlHours: config.tokenTtlHours
      }
    };
  });

  router.post('/api/auth/logout', async ({ req, db }) => {
    const token = extractToken(req);
    if (token) {
      const session = loadSession(db, token);
      if (session) revokeToken(db, session.tokenId);
    }
    return { status: 204, payload: null };
  });

  router.get(
    '/api/auth/me',
    async ({ db, session }) => {
      return {
        payload: {
          user: publicUser(session.user, session.roles, masterIdForUser(db, session.user.id))
        }
      };
    },
    { auth: true }
  );

  // Начало входа через «Яндекс»: отправляем браузер на страницу согласия.
  router.get('/api/auth/yandex', async () => {
    if (!yandexEnabled()) {
      throw new HttpError(503, 'yandex_disabled', 'Вход через «Яндекс» пока не настроен.');
    }
    return { redirect: buildAuthorizeUrl(issueOauthState()) };
  });

  // Возврат от «Яндекса». Здесь нельзя отдавать JSON: пользователь приходит
  // сюда браузером, поэтому в любом случае отвечаем перенаправлением на сайт.
  // Результат передаём во фрагменте адреса (#/login?yandex=...), чтобы токен
  // не попал в логи сервера и в заголовок Referer чужих страниц.
  router.get('/api/auth/yandex/callback', async ({ db, query }) => {
    const loginUrl = (status, token) => {
      const params = new URLSearchParams({ yandex: status });
      if (token) params.set('token', token);
      return `${appBase()}/#/login?${params.toString()}`;
    };

    if (!yandexEnabled()) return { redirect: loginUrl('disabled') };

    // Пользователь нажал «Отказать» на странице «Яндекса».
    if (query.get('error')) return { redirect: loginUrl('denied') };

    const code = query.get('code');
    if (!code || !consumeOauthState(query.get('state'))) {
      return { redirect: loginUrl('error') };
    }

    try {
      const accessToken = await exchangeCode(code);
      const profile = await fetchUserProfile(accessToken);

      const user = upsertExternalUser(db, {
        provider: 'yandex',
        providerId: profile.providerId,
        email: profile.email,
        name: profile.name
      });

      if (user.is_active !== 1) return { redirect: loginUrl('blocked') };

      const token = issueToken(db, user.id);
      logAttempt(db, { email: user.email, ip: null, succeeded: true });
      return { redirect: loginUrl('ok', token) };
    } catch {
      // Ни сетевую ошибку, ни отказ «Яндекса» пользователю не показываем
      // техническими словами — просто возвращаем на экран входа с пояснением.
      return { redirect: loginUrl('error') };
    }
  });

  return router;
}
