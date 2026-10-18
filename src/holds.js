/**
 * Временное удержание слота при оформлении записи.
 *
 * На экране подтверждения клиент видит таймер: выбранное время держится
 * несколько минут, пока он нажимает «Подтвердить». Это нужно, чтобы двое
 * случайно не открыли одно и то же время: первый увидит «занято» раньше,
 * чем слот достанется кому-то другому.
 *
 * Почему в памяти, а не в базе: это короткоживущее состояние, терять его
 * при перезапуске не страшно — клиент просто выберет время заново. Запись
 * в базу потребовала бы ещё одной таблицы, которая сама по себе является
 * «зарезервированным временем», и усложнила бы расчёт свободных слотов.
 *
 * Оговорка: при нескольких процессах сервера удержания перестанут быть
 * общими. На VPS с одним процессом (урок 5.6) это ограничение не проявится,
 * и окончательную защиту всё равно обеспечивает триггер в базе.
 */

import { config } from './config.js';

const holds = new Map();

/** Ключ удержания: мастер + начало слота. */
function keyOf(masterId, startsAt) {
  return `${masterId}:${startsAt}`;
}

/** Удаляет всё, что истекло. Вызывается перед каждым чтением и записью. */
export function sweep(now = Date.now()) {
  for (const [key, hold] of holds) {
    if (hold.expiresAt <= now) holds.delete(key);
  }
}

/**
 * Занимает слот.
 *
 * @returns {{ok: boolean, reason?: string, expiresAt?: number}}
 *   ok === false, если слот уже держит другой пользователь.
 */
export function acquireHold({ masterId, startsAt, endsAt, ownerKey }) {
  sweep();

  const key = keyOf(masterId, startsAt);
  const existing = holds.get(key);

  if (existing && existing.ownerKey !== ownerKey) {
    return { ok: false, reason: 'held_by_other' };
  }

  const expiresAt = Date.now() + config.holdTtlSec * 1000;
  holds.set(key, { masterId, startsAt, endsAt, ownerKey, expiresAt });

  return { ok: true, expiresAt, holdSeconds: config.holdTtlSec };
}

/** Освобождает слот. Освободить чужое удержание нельзя. */
export function releaseHold({ masterId, startsAt, ownerKey }) {
  const key = keyOf(masterId, startsAt);
  const existing = holds.get(key);

  if (!existing) return { ok: false, reason: 'not_held' };
  if (existing.ownerKey !== ownerKey) return { ok: false, reason: 'held_by_other' };

  holds.delete(key);
  return { ok: true };
}

/** Продлевает удержание, чтобы таймер на экране не истёк во время ввода. */
export function extendHold({ masterId, startsAt, ownerKey }) {
  sweep();

  const key = keyOf(masterId, startsAt);
  const existing = holds.get(key);

  if (!existing || existing.ownerKey !== ownerKey) return { ok: false, reason: 'held_by_other' };

  existing.expiresAt = Date.now() + config.holdTtlSec * 1000;
  return { ok: true, expiresAt: existing.expiresAt, holdSeconds: config.holdTtlSec };
}

/**
 * Удержания мастера, готовые к вычитанию из рабочего времени.
 *
 * @param {number} masterId
 * @param {string|null} [exceptOwnerKey] удержания этого пользователя не вычитать:
 *   он сам выбирает это время и должен видеть его свободным для себя
 */
export function holdsForMaster(masterId, exceptOwnerKey = null) {
  sweep();

  const result = [];
  for (const hold of holds.values()) {
    if (hold.masterId !== Number(masterId)) continue;
    if (exceptOwnerKey && hold.ownerKey === exceptOwnerKey) continue;

    result.push({
      start: Date.parse(hold.startsAt),
      end: Date.parse(hold.endsAt)
    });
  }

  return result;
}

/** Кто держит слот — для сообщения об ошибке. Только для внутреннего лога. */
export function ownerOf(masterId, startsAt) {
  return holds.get(keyOf(masterId, startsAt))?.ownerKey ?? null;
}

/** Удаляет все удержания. Используется в тестах. */
export function reset() {
  holds.clear();
}

export function size() {
  return holds.size;
}
