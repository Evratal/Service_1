/**
 * Аутентификация и проверка прав.
 *
 * Правила, которые соблюдает весь сервис:
 *
 *   1. Роли берутся ТОЛЬКО из таблицы user_roles. Значение role из тела запроса
 *      не читается никогда — иначе клиент отправил бы {"role":"admin"} и стал
 *      администратором.
 *   2. Права проверяются тремя независимыми шагами: к��то пришёл (токен),
 *      какая у него роль, чей это объект. Соединять их в одну проверку нельзя:
 *      одна универсальная функция либо ослабляет права, либо становится
 *      нечитаемой.
 *   3. Отсутствие токена — 401 «войдите», есть токен, но не та роль или не тот
 *      объект — 403 «нельзя». Разница понятна человеку и полезна при разборе.
 */

import { createToken, hashToken, utcInHours, utcNow } from './security.js';
import { forbidden, unauthorized } from './errors.js';
import { config } from './config.js';

/**
 * Достаёт токен из заголовка Authorization: Bearer <токен>.
 *
 * Токен в заголовке, а не в cookie: иначе браузер сам пришлёт его на любой
 * сторонний адрес и появляется целый класс атак (CSRF). Токен живёт в
 * localStorage и отправляется скриптом только на наш адрес.
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {string|null}
 */
export function extractToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;

  const [scheme, value] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
  if (!value || value.trim() === '') return null;

  return value.trim();
}

/**
 * Ищет активный токен и возвращает пользователя с его ролями.
 *
 * Токен проверяется по хешу: сам токен в базе не хранится. Отозванный
 * (revoked_at), просроченный (expires_at) и токен заблокированного пользователя
 * (is_active = 0) не подходят.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} token
 * @returns {{user: object, roles: string[], tokenId: number}|null}
 */
export function loadSession(db, token) {
  const row = db
    .prepare(
      `SELECT
         t.id           AS token_id,
         u.id           AS id,
         u.email        AS email,
         u.name         AS name,
         u.phone        AS phone,
         u.is_active    AS is_active
       FROM auth_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?
         AND t.revoked_at IS NULL
         AND t.expires_at > ?
         AND u.is_active = 1`
    )
    .get(hashToken(token), utcNow());

  if (!row) return null;

  const roles = db
    .prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role')
    .all(row.id)
    .map((r) => r.role);

  const { token_id: tokenId, ...user } = row;
  return { user, roles, tokenId };
}

/**
 * Проверяет токен и кладёт сессию в контекст запроса.
 * Без токена запрос не проходит дальше — 401.
 *
 * @returns {{user: object, roles: string[], tokenId: number}}
 */
export function requireSession(db, req) {
  const token = extractToken(req);
  if (!token) throw unauthorized();

  const session = loadSession(db, token);
  if (!session) throw unauthorized('Токен недействителен или истёк. Войдите заново.');

  return session;
}

/**
 * Читает сессию, если она есть, но не требует её.
 *
 * Нужно для маршрутов, открытых всем, которые ведут себя по-разному для
 * вошедшего и для гостя. Например, список свободных слотов: гостю показываем
 * слот, который держит другой человек, как занятый, а тому, кто держит его сам,
 * показываем как свободный для себя.
 *
 * Ошибка разбора токена не превращается в 401: маршрут и так открыт, а
 * недействительный токен здесь равносилен отсутствию токена.
 *
 * @returns {{user: object, roles: string[], tokenId: number}|null}
 */
export function optionalSession(db, req) {
  const token = extractToken(req);
  if (!token) return null;

  try {
    return loadSession(db, token);
  } catch {
    return null;
  }
}

/**
 * Проверяет наличие роли. Роль `client` есть у всех, поэтому проверка «есть
 * ли доступ вообще» может опираться на неё.
 *
 * @param {{roles: string[]}} session
 * @param {string} role
 */
export function requireRole(session, role) {
  if (!session.roles.includes(role)) {
    throw forbidden(`Это действие доступно только с ролью ${role}.`);
  }
}

/** Проверяет, что у пользователя есть хотя бы одна из ролей. */
export function requireAnyRole(session, roles) {
  if (!roles.some((role) => session.roles.includes(role))) {
    throw forbidden(`Это действие доступно только с ролью: ${roles.join(', ')}.`);
  }
}

/** Может ли администратор. */
export const isAdmin = (session) => session.roles.includes('admin');

/**
 * Проверяет доступ к конкретной записи.
 *
 * Это третья, самая важная проверка: «кто пришёл» и «какая роль» уже проверены,
 * а здесь выясняется, чей это объект. Без неё любой авторизованный клиент
 * смог бы открыть чужую запись, перебрав идентификатор.
 *
 * Правила:
 *   * администратор видит всё;
 *   * мастер видит записи, где он исполнитель;
 *   * клиент видит только свои записи.
 */
export function canAccessAppointment(session, appointment) {
  if (!appointment) throw forbidden('Запись не найдена.');
  if (isAdmin(session)) return true;
  if (appointment.client_id === session.user.id) return true;
  return session.roles.includes('master') && appointment.master_id === session.masterId;
}

/** Выдаёт новый токен и записывает его хеш в базу. Возвращает сам токен. */
export function issueToken(db, userId) {
  const token = createToken();
  const now = utcNow();

  db.prepare(
    'INSERT INTO auth_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)'
  ).run(userId, hashToken(token), utcInHours(config.tokenTtlHours), now);

  return token;
}

/** Отзывает токен при выходе из аккаунта. */
export function revokeToken(db, tokenId) {
  db.prepare('UPDATE auth_tokens SET revoked_at = ? WHERE id = ?').run(utcNow(), tokenId);
}

/** Удаляет у пользователя все просроченные и отозванные токены. */
export function pruneTokens(db) {
  db.prepare('DELETE FROM auth_tokens WHERE expires_at < ? OR revoked_at IS NOT NULL').run(utcNow());
}
