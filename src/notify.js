/**
 * Тексты уведомлений.
 *
 * Сообщение собирается на сервере: формулировки должны быть одинаковыми для
 * всех клиентов, а не зависеть от того, как каждый разработчик клиента
 * решит написать текст. Сюда же приходят данные, которых у клиента может
 * не оказаться (например, имя мастера).
 */

import { utcToZonedParts } from './time.js';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

/** «12 сентября, 15:30» в часовом поясе студии. */
function describeMoment(startsAt, timezone) {
  const parts = utcToZonedParts(startsAt, timezone);
  return `${parts.day} ${MONTHS[parts.month - 1]}, ${parts.time}`;
}

function masterNameOf(appointment) {
  return appointment?.master?.name ?? 'мастер';
}

/** Уведомление о том, что запись создана (в т.ч. администратором). */
export function createdNotification(appointment, timezone, { byAdmin } = {}) {
  const startsAt = describeMoment(appointment.starts_at, timezone);
  const who = byAdmin ? 'администратором студии' : 'вами';
  return {
    kind: 'appointment_created',
    title: 'Новая запись',
    message: `Запись №${appointment.id} на ${startsAt} к мастеру ${masterNameOf(appointment)} создана ${who}.`
  };
}

/** Уведомление об отмене записи администратором или мастером. */
export function cancelledNotification(appointment, timezone, { reason } = {}) {
  const startsAt = describeMoment(appointment.starts_at, timezone);
  const reasonText = reason ? ` Причина: ${reason}.` : '';
  return {
    kind: 'appointment_cancelled',
    title: 'Запись отменена',
    message: `Запись №${appointment.id} на ${startsAt} к мастеру ${masterNameOf(appointment)} отменена администратором.${reasonText}`
  };
}

/** Уведомление о переносе записи администратором. */
export function rescheduledNotification(appointment, timezone) {
  const startsAt = describeMoment(appointment.starts_at, timezone);
  return {
    kind: 'appointment_rescheduled',
    title: 'Запись перенесена',
    message: `Запись №${appointment.id} перенесена на ${startsAt} к мастеру ${masterNameOf(appointment)}. Новое время уже в кабинете.`
  };
}

/** Уведомление о записи поверх занятого времени (наложение администратора). */
export function overrideNotification(appointment, timezone) {
  const startsAt = describeMoment(appointment.starts_at, timezone);
  return {
    kind: 'appointment_override',
    title: 'Запись на занятое время',
    message: `Запись №${appointment.id} на ${startsAt} к мастеру ${masterNameOf(appointment)} создана администратором поверх занятого времени.`
  };
}