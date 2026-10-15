/**
 * Вход через «Яндекс» (OAuth 2.0).
 *
 * Здесь ровно два обращения к «Яндексу»:
 *   1. обмен кода авторизации на токен доступа;
 *   2. чтение профиля пользователя (идентификатор, почта, имя).
 *
 * Токен «Яндекса» нигде не сохраняется: он нужен только чтобы один раз
 * прочитать профиль и живёт внутри функции обмена. Наш собственный токен
 * сессии выдаёт уже маршрут (src/auth.js).
 *
 * Все сетевые вызовы ограничены таймаутом: иначе недоступность «Яндекса»
 * подвесила бы запрос пользователя на неопределённое время.
 */

import { config } from './config.js';
import { HttpError } from './errors.js';

const AUTHORIZE_URL = 'https://oauth.yandex.ru/authorize';
const TOKEN_URL = 'https://oauth.yandex.ru/token';
const USERINFO_URL = 'https://login.yandex.ru/info?format=json';
const TIMEOUT_MS = 10_000;

/** Включён ли вход через «Яндекс» (заданы ли все три настройки). */
export function yandexEnabled() {
  return config.yandex.enabled;
}

/** Адрес, на который отправляем пользователя для подтверждения входа. */
export function buildAuthorizeUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.yandex.clientId,
    redirect_uri: config.yandex.redirectUri,
    state
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Меняет код авторизации на токен доступа.
 * @returns {Promise<string>} токен «Яндекса»
 */
export async function exchangeCode(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.yandex.clientId,
    client_secret: config.yandex.clientSecret
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new HttpError(502, 'yandex_token_failed', '«Яндекс» отклонил обмен кода на токен.');
  }

  const data = await response.json().catch(() => null);
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new HttpError(502, 'yandex_token_failed', '«Яндекс» не вернул токен доступа.');
  }
  return data.access_token;
}

/**
 * Читает профиль пользователя по токену.
 *
 * Почта обязательна: без неё нечем связать аккаунт и некуда отправлять
 * уведомления, поэтому такой вход отклоняем. Имя может отсутствовать —
 * тогда подставляем часть адреса до «@».
 *
 * @returns {Promise<{ providerId: string, email: string, name: string }>}
 */
export async function fetchUserProfile(accessToken) {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `OAuth ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new HttpError(502, 'yandex_profile_failed', 'Не удалось получить профиль из «Яндекса».');
  }

  const data = await response.json().catch(() => null);
  if (!data || data.id === undefined || data.id === null) {
    throw new HttpError(502, 'yandex_profile_failed', '«Яндекс» вернул некорректный профиль.');
  }

  const email = data.default_email || (Array.isArray(data.emails) && data.emails[0]) || '';
  if (!email) {
    throw new HttpError(502, 'yandex_no_email', '«Яндекс» не вернул адрес электронной почты.');
  }

  const fullName =
    data.real_name ||
    [data.first_name, data.last_name].filter(Boolean).join(' ') ||
    data.display_name ||
    data.login ||
    '';

  return {
    providerId: String(data.id),
    email: String(email).toLowerCase(),
    name: fullName.trim() || String(email).split('@')[0]
  };
}
