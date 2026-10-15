/**
 * Расчёт свободных слотов мастера.
 *
 * Главное вычисляемое значение сервиса. В базе нет таблицы свободного времени,
 * и это осознанно: если мастер поменяет график или услуга станет длиннее,
 * такую таблицу пришлось бы пересобирать, и она быстро перестала бы
 * соответствовать реальному расписанию.
 *
 * Порядок вычисления:
 *   1. график мастера на этот день недели (или выходной — пусто);
 *   2. перевод местного времени студии в UTC;
 *   3. вычитание занятых интервалов: активные записи, разовые блокировки
 *      и слоты, которые прямо сейчас держит другой пользователь;
 *   4. разрезание остатка на окна длительностью услуги;
 *   5. отсечение прошедшего времени.
 */

import { formatUtc, utcToZonedParts, zonedToUtc } from './time.js';

/** Шаг сетки начала слотов, минут. */
const DEFAULT_STEP_MIN = 15;

/** Длительность по умолчанию, если услуга не выбрана. */
const DEFAULT_DURATION_MIN = 30;

/** Насколько далеко в будущее можно записываться. */
const DEFAULT_HORIZON_DAYS = 60;

/** Сколько минут должно остаться до визита, чтобы он считался доступным. */
const LEAD_TIME_MIN = 30;

/** Интервалы пересекаются, если начало одного раньше конца другого. */
function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && aEnd > bStart;
}

/** Разбирает дату YYYY-MM-DD в части. */
function dateParts(date) {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}

/** Число дней от эпохи для календарной даты: сравнение дат без часовых поясов. */
function dayIndex(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** Часы и минуты из строки «ЧЧ:ММ». */
function hoursOf(text) {
  return Number(text.slice(0, 2));
}

function minutesOf(text) {
  return Number(text.slice(3, 5));
}

/**
 * Возвращает занятые интервалы мастера на указанный день, в миллисекундах.
 *
 * @param {object} db
 * @param {number} masterId
 * @param {number} dayStartMs
 * @param {number} dayEndMs
 * @param {number[]} [heldSlotIds] интервалы, удерживаемые другими пользователями
 * @param {number} [excludeAppointmentId] запись, которую нужно не считать занятой
 *   (переносимая запись «уезжает» со своего старого времени)
 */
export function busyIntervals(db, masterId, dayStartMs, dayEndMs, heldSlotIds = [], excludeAppointmentId = null) {
  const intervals = [];

  // Записи. Только статус booked: отменённые и завершённые визиты
  // освобождают время для новой записи.
  const appointments = db
    .prepare(
      `SELECT id, starts_at, ends_at
         FROM appointments
        WHERE master_id = ?
          AND status = 'booked'
          AND starts_at < ?
          AND ends_at   > ?
        ORDER BY starts_at`
    )
    .all(masterId, formatUtc(new Date(dayEndMs)), formatUtc(new Date(dayStartMs)));

  for (const row of appointments) {
    // Переносимая запись в момент сдвига занимает время, на которое «уедет»:
    // её текущий интервал не должен мешать расчёту.
    if (row.id === excludeAppointmentId) continue;
    intervals.push({
      start: Date.parse(row.starts_at),
      end: Date.parse(row.ends_at),
      source: 'appointment',
      id: row.id
    });
  }

  const blocks = db
    .prepare(
      `SELECT id, starts_at, ends_at, reason
         FROM time_blocks
        WHERE master_id = ?
          AND starts_at < ?
          AND ends_at   > ?
        ORDER BY starts_at`
    )
    .all(masterId, formatUtc(new Date(dayEndMs)), formatUtc(new Date(dayStartMs)));

  for (const row of blocks) {
    intervals.push({
      start: Date.parse(row.starts_at),
      end: Date.parse(row.ends_at),
      source: 'block',
      id: row.id,
      reason: row.reason
    });
  }

  for (const held of heldSlotIds) {
    intervals.push({ ...held, source: 'hold' });
  }

  return intervals;
}

/**
 * Считает свободные слоты мастера на дату.
 *
 * @param {object} params
 * @param {object} params.db
 * @param {number} params.masterId
 * @param {string} params.date YYYY-MM-DD в местном времени студии
 * @param {string} params.timezone часовой пояс студии
 * @param {number} [params.durationMin] суммарная длительность услуг, минут
 * @param {number[]} [params.serviceIds] услуги: проверяются и суммируются
 * @param {object[]} [params.holds] интервалы, удерживаемые в памяти сервера
 * @param {number} [params.excludeAppointmentId] запись, которую не считать занятой
 * @param {Date} [params.now]
 * @returns {{slots: object[], total: number, reason?: string}}
 */
export function computeFreeSlots({
  db,
  masterId,
  date,
  timezone,
  durationMin = null,
  serviceIds = null,
  holds = [],
  excludeAppointmentId = null,
  now = new Date()
}) {
  const empty = { slots: [], total: 0 };

  const master = db
    .prepare('SELECT id, is_active FROM masters WHERE id = ?')
    .get(masterId);

  if (!master || master.is_active !== 1) {
    return { ...empty, reason: 'master_unavailable' };
  }

  // Шаг сетки привязан к длительности: нельзя предлагать слоты чаще, чем
  // раз в 15 минут, и не чаще, чем сама услуга.
  let duration = Number.isInteger(durationMin) && durationMin > 0 ? durationMin : null;
  let step = DEFAULT_STEP_MIN;

  if (duration === null && Array.isArray(serviceIds) && serviceIds.length > 0) {
    const placeholders = serviceIds.map(() => '?').join(',');
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(duration_min), 0) AS total
           FROM services
          WHERE id IN (${placeholders}) AND is_active = 1`
      )
      .get(...serviceIds);

    duration = Number(totals.total) > 0 ? Number(totals.total) : null;
  }

  if (duration === null) duration = DEFAULT_DURATION_MIN;
  if (duration > 12 * 60) return { ...empty, reason: 'duration_too_long' };

  // Дата запроса считается в местном времени студии: клиент спрашивает про
  // 15-е число, и это именно 15-е в Москве, а не в UTC.
  const localNow = utcToZonedParts(now, timezone);
  const todayIndex = dayIndex(localNow.year, localNow.month, localNow.day);

  const parts = dateParts(date);
  const requestedIndex = dayIndex(parts.year, parts.month, parts.day);

  if (requestedIndex < todayIndex) return { ...empty, reason: 'date_in_past' };
  if (requestedIndex > todayIndex + DEFAULT_HORIZON_DAYS) return { ...empty, reason: 'date_too_far' };

  // День недели в местном времени студии, 0 — воскресенье.
  const dayNoon = zonedToUtc({ ...parts, hour: 12, minute: 0 }, timezone);
  const weekday = utcToZonedParts(dayNoon, timezone).weekday;

  const schedule = db
    .prepare('SELECT * FROM schedules WHERE master_id = ? AND weekday = ?')
    .get(masterId, weekday);

  if (!schedule || schedule.is_working !== 1) {
    return { ...empty, reason: 'day_off' };
  }

  const startMs = zonedToUtc({ ...parts, hour: hoursOf(schedule.start_time), minute: minutesOf(schedule.start_time) }, timezone).getTime();
  const endMs = zonedToUtc({ ...parts, hour: hoursOf(schedule.end_time), minute: minutesOf(schedule.end_time) }, timezone).getTime();

  if (endMs <= startMs) return { ...empty, reason: 'invalid_schedule' };

  const busy = busyIntervals(db, masterId, startMs, endMs, holds, excludeAppointmentId);

  // Первый момент, который можно предложить: для сегодняшнего дня —
  // не раньше, чем через LEAD_TIME_MIN от текущего момента.
  const earliestAllowed =
    requestedIndex === todayIndex ? now.getTime() + LEAD_TIME_MIN * 60_000 : startMs;

  const slots = [];
  for (let cursor = startMs; cursor + duration * 60_000 <= endMs; cursor += step * 60_000) {
    const slotStart = cursor;
    const slotEnd = cursor + duration * 60_000;

    if (slotStart < earliestAllowed) continue;
    if (busy.some((interval) => overlaps(slotStart, slotEnd, interval.start, interval.end))) continue;

    const local = utcToZonedParts(new Date(slotStart), timezone);

    slots.push({
      startsAt: formatUtc(new Date(slotStart)),
      endsAt: formatUtc(new Date(slotEnd)),
      time: local.time,
      date: local.date,
      durationMin: duration
    });
  }

  return {
    slots,
    total: slots.length,
    reason: slots.length === 0 ? 'no_free_time' : undefined
  };
}

export { overlaps, LEAD_TIME_MIN, DEFAULT_STEP_MIN, DEFAULT_HORIZON_DAYS };
