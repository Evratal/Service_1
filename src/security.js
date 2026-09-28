/**
 * Пароли и токены: хеширование и безопасное сравнение.
 *
 * Здесь нет ни одного стороннего пакета — только node:crypto.
 * Правило, которое проходит через весь модуль: пароль и токен нигде
 * не сохраняются в исходном виде, только их необратимые хеши.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Параметры scrypt. Увеличение N делает подбор пароля дороже для атакующего.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

const SCRYPT_PREFIX = 'scrypt';

/**
 * Хеширует пароль со случайной солью.
 *
 * Формат: scrypt$N$r$p$<соль base64>$<хеш base64>
 * Параметры записаны внутрь строки, поэтому позже их можно усилить, и старые
 * хеши останутся проверяемыми.
 *
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('Пароль должен быть непустой строкой');
  }

  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024
  });

  return [
    SCRYPT_PREFIX,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derived.toString('base64')
  ].join('$');
}

/**
 * Проверяет пароль против сохранённого хеша.
 *
 * Сравнение постоянного времени (timingSafeEqual) нужно, чтобы по времени
 * ответа нельзя было подбирать хеш побайтно. Возвращает false при любой
 * ошибке формата, а не бросает исключение.
 *
 * @param {string} password
 * @param {string} stored
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return false;

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;

  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let derived;
  try {
    derived = await scryptAsync(password, salt, expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
      maxmem: 64 * 1024 * 1024
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Создаёт токен доступа. Возвращается клиенту один раз и больше
 * нигде не сохраняется — в базе лежит только хеш.
 *
 * @returns {string}
 */
export function createToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Хеш токена для хранения и поиска в auth_tokens.
 * SHA-256 здесь уместен: токен — случайные 32 байта, перебирать нечего,
 * а поиск по хешу должен быть быстрым.
 *
 * @param {string} token
 * @returns {string}
 */
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/** Момент времени в формате, принятом в базе: UTC с буквой Z. */
export function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Момент через N часов в формате базы.
 * @param {number} hours
 * @returns {string}
 */
export function utcInHours(hours) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
