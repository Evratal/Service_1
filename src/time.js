/**
 * Работа со временем.
 *
 * В базе моменты времени хранятся в UTC строкой вида YYYY-MM-DDTHH:MM:SSZ,
 * а расписание мастера — местным временем студии в формате HH:MM. Модуль
 * переводит одно в другое через IANA-часовой пояс из таблицы salon.
 *
 * Почему это нельзя делать «в лоб»: в Москве зимой UTC+3, летом UTC+4.
 * Без пересчёта запись на «15:00» либо уедет на час назад, либо вперёд,
 * и половина записей окажется не в том часе.
 */

const MS_PER_MIN = 60_000;

/** Часовой пояс студии. Заменяется на значение из таблицы salon. */
export const DEFAULT_TIMEZONE = 'Europe/Moscow';

/** Момент времени в формате базы: UTC с буквой Z, без миллисекунд. */
export function formatUtc(date) {
  return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Разбирает строку базы в Date. */
export function parseUtc(text) {
  return new Date(text);
}

/**
 * Смещение часового пояса в миллисекундах на указанный момент.
 * Внутренняя функция: сравнивает «как видит в этой зоне» и «как есть в UTC».
 */
function zoneOffsetMs(utcDate, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
    .formatToParts(utcDate)
    .reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return asIfUtc - utcDate.getTime();
}

/**
 * Переводит местное время студии в момент UTC.
 *
 * @param {{year:number, month:number, day:number, hour:number, minute:number}} local
 * @param {string} [timeZone]
 * @returns {Date}
 */
export function zonedToUtc(local, timeZone = DEFAULT_TIMEZONE) {
  const asIfUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute ?? 0,
    0
  );

  // Первый проход даёт приблизительное смещение. Второй нужен для дат,
  // попадающих на переход на летнее время: смещение там меняется, и первый
  // расчёт оказывается на час неточным.
  let utcMs = asIfUtc - zoneOffsetMs(new Date(asIfUtc), timeZone);
  utcMs = asIfUtc - zoneOffsetMs(new Date(utcMs), timeZone);

  return new Date(utcMs);
}

/**
 * Разбирает момент UTC на части в местном времени студии.
 *
 * @param {Date|string} moment
 * @param {string} [timeZone]
 * @returns {{year:number, month:number, day:number, hour:number, minute:number, weekday:number, date:string, time:string}}
 */
export function utcToZonedParts(moment, timeZone = DEFAULT_TIMEZONE) {
  const date = new Date(moment);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      if (part.type !== 'literal') acc[part.type] = part.value;
      return acc;
    }, {});

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);

  // Индекс в том же порядке, что и weekday в SQLite: 0 — воскресенье.
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = weekdays.indexOf(parts.weekday);
  if (weekday === -1) {
    throw new RangeError(`Не удалось определить день недели для ${date.toISOString()}`);
  }

  const pad = (n) => String(n).padStart(2, '0');

  return {
    year,
    month,
    day,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday,
    date: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(parts.hour)}:${pad(parts.minute)}`
  };
}

/** День недели в студии: 0 — воскресенье, 6 — суббота. */
export function weekdayInZone(moment, timeZone = DEFAULT_TIMEZONE) {
  return utcToZonedParts(moment, timeZone).weekday;
}

/** Разбирает «ЧЧ:ММ» в минуты от начала суток. */
export function parseHhMm(text) {
  const match = /^(\d{2}):(\d{2})$/.exec(text ?? '');
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Проверяет, что строка — календарная дата YYYY-MM-DD. */
export function isValidDateString(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text ?? '')) return false;
  const [year, month, day] = text.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/** Прибавляет минуты к моменту времени. */
export function addMinutes(moment, minutes) {
  return new Date(new Date(moment).getTime() + minutes * MS_PER_MIN);
}
