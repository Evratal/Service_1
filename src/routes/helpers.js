/**
 * Общие мелочи для маршрутов: разбор параметров запроса и поиск тела.
 */

import { realClientIp } from '../client-ip.js';

/**
 * Список положительных целых из строки запроса.
 *
 * Поддерживаются оба обычных способа передачи:
 *   ?serviceIds=1,2,3
 *   ?serviceIds=1&serviceIds=2
 *
 * Нечисловые значения молча пропускаются, а не считаются ошибкой: клиент
 * может прислать пустой фильтр, и это не повод отвечать ошибкой 400.
 */
export function parseIdList(searchParams, name) {
  const raw = searchParams.getAll(name).flatMap((value) => value.split(','));
  const ids = [];

  for (const value of raw) {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const id = Number(trimmed);
    if (id >= 1 && id <= 2 ** 31 - 1 && !ids.includes(id)) ids.push(id);
  }

  return ids;
}

/** Строка запроса как целое число, либо значение по умолчанию. */
export function parseIntParam(searchParams, name, fallback = null) {
  const raw = searchParams.get(name);
  if (raw === null || !/^-?\d+$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
}

/** Параметр из пути как положительное целое число, либо null. */
export function pathId(params, name) {
  const raw = params[name];
  if (!/^\d+$/.test(raw ?? '')) return null;
  const id = Number(raw);
  return id >= 1 ? id : null;
}

/** Ключ удержания: пользователь, а для гостя — адрес. */
export function ownerKeyOf(session, req) {
  if (session) return `user:${session.user.id}`;
  return `ip:${realClientIp(req)}`;
}
