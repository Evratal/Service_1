/**
 * Маршруты записей и удержания слота.
 *
 * Все маршруты здесь требуют входа: они объявлены с опцией `{ auth: true }`,
 * и разбор сессии делает сервер до вызова обработчика. Порядок проверок прав
 * в каждом маршруте один и тот же:
 *
 *   1. кто пришёл   — токен, иначе 401;
 *   2. какая роль   — иначе 403;
 *   3. чей это объект — иначе 403.
 *
 * Первая и вторая проверки одинаковы для всех, третья — разная: именно она
 * не даёт авторизованному пользователю открыть чужую запись.
 */

import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isAdmin, canAccessAppointment, requireRole } from '../auth.js';
import { validate, cleanText } from '../validate.js';
import { acquireHold, extendHold, holdsForMaster, releaseHold } from '../holds.js';
import { formatUtc, isValidDateString, utcToZonedParts } from '../time.js';
import { computeFreeSlots } from '../slots.js';
import { getSalon } from '../repo/catalog.js';
import { masterIdForUser } from '../repo/users.js';
import { createNotification } from '../repo/notifications.js';
import {
  cancelAppointment,
  createAppointment,
  dayBoundsUtc,
  getAppointment,
  listAppointments,
  rescheduleAppointment
} from '../repo/appointments.js';
import {
  cancelledNotification,
  createdNotification,
  overrideNotification,
  rescheduledNotification
} from '../notify.js';
import { ownerKeyOf, parseIntParam, pathId } from './helpers.js';

const APPOINTMENT_STATUSES = ['booked', 'completed', 'cancelled_by_client', 'cancelled_by_salon', 'no_show'];
const SCOPES = ['mine', 'master', 'all'];

const AUTH = { auth: true };

const CREATE_RULES = {
  masterId: { type: 'int', required: true, min: 1 },
  serviceIds: { type: 'idList', required: true, maxItems: 10 },
  startsAt: { type: 'string', required: true, max: 32 },
  notes: { type: 'string', required: false, max: 500, nullable: true }
};

export function registerAppointmentRoutes(router) {
  /**
   * Создание записи.
   *
   * Кто за кого записывается:
   *   * клиент — только за себя;
   *   * мастер или администратор — может указать clientId.
   *
   * Поле clientId из тела запроса читается только при соответствующей роли.
   * Для клиента оно игнорируется: иначе можно было бы записать другого
   * человека, просто подставив чужой идентификатор.
   */
  router.post(
    '/api/appointments',
    async ({ db, body, session, req }) => {
      const data = validate(body, CREATE_RULES);

      const mayBookForOthers = isAdmin(session) || session.roles.includes('master');
      const requestedClientId = Number.isInteger(body.clientId) ? body.clientId : null;

      if (requestedClientId !== null && requestedClientId !== session.user.id && !mayBookForOthers) {
        throw forbidden('Записать другого человека может только мастер или администратор.');
      }

      const clientId = mayBookForOthers && requestedClientId !== null ? requestedClientId : session.user.id;

      // Признак наложения ставит только роль admin, и только если сервер
      // разрешил слот. Значение из тела запроса само по себе ничего не значит.
      const isOverride = isAdmin(session) && body.isOverride === true;

      const salon = getSalon(db);
      if (!salon) throw notFound('Студия не настроена. Выполните npm run seed.');

      const startsAt = new Date(data.startsAt);
      if (Number.isNaN(startsAt.getTime())) {
        throw badRequest('Некорректное время начала визита. Ожидается 2026-09-28T12:00:00Z.');
      }
      if (startsAt.getTime() < Date.now()) {
        throw badRequest('Нельзя записаться на время в прошлом.');
      }

      const { appointment } = createAppointment(db, {
        clientId,
        masterId: data.masterId,
        serviceIds: data.serviceIds,
        startsAtIso: formatUtc(startsAt),
        actorId: session.user.id,
        isOverride,
        notes: cleanText(data.notes ?? null),
        // Свои удержания не вычитаем: клиент должен видеть выбранное им
        // время свободным для себя.
        holds: holdsForMaster(data.masterId, ownerKeyOf(session, req))
      });

      // Если запись создал не сам клиент (мастер или администратор записал
      // другого человека), сообщаем клиенту об этом уведомлением.
      if (clientId !== session.user.id) {
        const note = isOverride
          ? overrideNotification(appointment, salon.timezone)
          : createdNotification(appointment, salon.timezone, { byAdmin: true });
        createNotification(db, { userId: clientId, appointmentId: appointment.id, ...note });
      }

      return { status: 201, payload: { appointment: publicAppointment(appointment, salon.timezone) } };
    },
    AUTH
  );

  /** Список записей. Объём уже ограничен правилами доступа и фильтром scope. */
  router.get(
    '/api/appointments',
    async ({ db, query, session }) => {
      const scope = query.get('scope') ?? 'mine';

      if (!SCOPES.includes(scope)) {
        throw badRequest(`scope может быть: ${SCOPES.join(', ')}.`);
      }
      if (scope === 'all' && !isAdmin(session)) {
        throw forbidden('Просматривать все записи может только администратор.');
      }
      if (scope === 'master' && !(isAdmin(session) || session.roles.includes('master'))) {
        throw forbidden('Смотреть расписание мастера может только мастер или администратор.');
      }

      const status = query.get('status');
      if (status && !APPOINTMENT_STATUSES.includes(status)) {
        throw badRequest(`Неизвестный статус: ${status}.`);
      }

      const salon = getSalon(db);
      if (!salon) throw notFound('Студия не настроена. Выполните npm run seed.');

      const date = query.get('date');
      let fromIso = null;
      let toIso = null;
      if (date) {
        if (!isValidDateString(date)) {
          throw badRequest('Некорректная дата: ожидается YYYY-MM-DD.');
        }
        const bounds = dayBoundsUtc(date, salon.timezone);
        fromIso = bounds.fromIso;
        toIso = bounds.toIso;
      }

      const ownMasterId = masterIdForUser(db, session.user.id);
      const masterFilter = parseIntParam(query, 'masterId', null);

      // Фильтр по мастеру клиенту не доступен: иначе он видел бы чужие записи.
      if (masterFilter !== null && !isAdmin(session) && !session.roles.includes('master')) {
        throw forbidden('Фильтр по мастеру доступен только мастеру и администратору.');
      }

      const appointments = listAppointments(db, {
        userId: session.user.id,
        masterId: masterFilter ?? ownMasterId,
        isAdmin: isAdmin(session),
        scope,
        status,
        fromIso,
        toIso
      });

      return {
        payload: {
          appointments: appointments.map((appointment) => publicAppointment(appointment, salon.timezone))
        }
      };
    },
    AUTH
  );

  /** Одна запись. Доступ — только владельцу, исполнителю или администратору. */
  router.get(
    '/api/appointments/:id',
    async ({ db, params, session }) => {
      const id = pathId(params, 'id');
      if (id === null) throw badRequest('Некорректный идентификатор записи.');

      const appointment = getAppointment(db, id);
      if (!appointment) throw notFound('Запись не найдена.');

      const salon = getSalon(db);
      const masterId = masterIdForUser(db, session.user.id);
      if (!canAccessAppointment({ ...session, masterId }, appointment)) {
        throw forbidden('Эта запись принадлежит другому клиенту.');
      }

      return { payload: { appointment: publicAppointment(appointment, salon.timezone) } };
    },
    AUTH
  );

  /** Отмена записи. */
  router.post(
    '/api/appointments/:id/cancel',
    async ({ db, params, body, session }) => {
      const id = pathId(params, 'id');
      if (id === null) throw badRequest('Некорректный идентификатор записи.');

      const appointment = getAppointment(db, id);
      if (!appointment) throw notFound('Запись не найдена.');

      const masterId = masterIdForUser(db, session.user.id);
      if (!canAccessAppointment({ ...session, masterId }, appointment)) {
        throw forbidden('Эту запись нельзя отменить: она принадлежит другому клиенту.');
      }

      if (appointment.status !== 'booked') {
        throw badRequest(`Запись уже имеет статус ${appointment.status} и не может быть отменена.`);
      }

      // Формулировку статуса определяет сервер по роли, а не клиент:
      // клиент не может выбрать, записано «отменена клиентом» или «салоном».
      const bySalon = isAdmin(session) || appointment.client_id !== session.user.id;
      const reason = cleanText(typeof body.reason === 'string' ? body.reason : null);

      const updated = cancelAppointment(db, appointment, { bySalon, reason });
      const salon = getSalon(db);

      // Клиенту сообщаем только о записях, отменённых за него администратором
      // или мастером. Свою отмену он совершил сам — уведомление излишне.
      if (bySalon && updated.client_id !== session.user.id) {
        const note = cancelledNotification(updated, salon.timezone, { reason });
        createNotification(db, { userId: updated.client_id, appointmentId: updated.id, ...note });
      }

      return { payload: { appointment: publicAppointment(updated, salon.timezone) } };
    },
    AUTH
  );

  /** Перенос записи. Доступен только администратору. */
  router.post(
    '/api/appointments/:id/reschedule',
    async ({ db, params, body, session }) => {
      // «Кто пришёл» проверено (маршрут с auth), «какая роль» — здесь.
      requireRole(session, 'admin');

      const id = pathId(params, 'id');
      if (id === null) throw badRequest('Некорректный идентификатор записи.');

      const appointment = getAppointment(db, id);
      if (!appointment) throw notFound('Запись не найдена.');

      if (appointment.status !== 'booked') {
        throw badRequest(`Перенести можно только активную запись, а её статус сейчас ${appointment.status}.`);
      }

      const data = validate(body, {
        startsAt: { type: 'string', required: true, max: 32 },
        isOverride: { type: 'boolean', required: false, default: false }
      });

      const startsAt = new Date(data.startsAt);
      if (Number.isNaN(startsAt.getTime())) {
        throw badRequest('Некорректное время начала визита. Ожидается 2026-09-28T12:00:00Z.');
      }
      if (startsAt.getTime() < Date.now()) {
        throw badRequest('Нельзя перенести запись на время в прошлом.');
      }

      const salon = getSalon(db);
      if (!salon) throw notFound('Студия не настроена. Выполните npm run seed.');

      const wanted = formatUtc(startsAt);
      // Перенос на то же время — не перенос, ничего не меняем.
      if (wanted === appointment.starts_at) {
        return { payload: { appointment: publicAppointment(appointment, salon.timezone) } };
      }

      const durationMin = appointment.totalDurationMin;
      const local = utcToZonedParts(startsAt, salon.timezone);

      const computed = computeFreeSlots({
        db,
        masterId: appointment.master_id,
        date: local.date,
        timezone: salon.timezone,
        durationMin,
        holds: [],
        excludeAppointmentId: appointment.id
      });

      const available = computed.slots.find((slot) => slot.startsAt === wanted);

      if (!available && !data.isOverride) {
        throw conflict(
          'slot_unavailable',
          'Это время больше недоступно. Выберите другой слот.',
          {
            reason: computed.reason ?? 'slot_taken',
            requested: wanted,
            totalDurationMin: durationMin,
            availableSlots: computed.slots.slice(0, 12)
          }
        );
      }

      const endsAtIso = available
        ? available.endsAt
        : formatUtc(new Date(startsAt.getTime() + durationMin * 60_000));

      const updated = rescheduleAppointment(db, id, {
        startsAtIso: wanted,
        endsAtIso,
        isOverride: !available
      });

      const note = rescheduledNotification(updated, salon.timezone);
      createNotification(db, { userId: updated.client_id, appointmentId: updated.id, ...note });

      return { payload: { appointment: publicAppointment(updated, salon.timezone) } };
    },
    AUTH
  );

  /* ------------------------------------------------------------ удержание слота */

  /** Клиент начал оформлять запись и держит время. */
  router.post(
    '/api/holds',
    async ({ db, body, req, session }) => {
      const data = validate(body, {
        masterId: { type: 'int', required: true, min: 1 },
        startsAt: { type: 'string', required: true, max: 32 },
        endsAt: { type: 'string', required: true, max: 32 }
      });

      if (Number.isNaN(new Date(data.startsAt).getTime()) || Number.isNaN(new Date(data.endsAt).getTime())) {
        throw badRequest('Некорректное время удержания.');
      }

      const result = acquireHold({
        masterId: data.masterId,
        startsAt: data.startsAt,
        endsAt: data.endsAt,
        ownerKey: ownerKeyOf(session, req)
      });

      if (!result.ok) {
        throw badRequest('Это время уже выбрал другой клиент. Обновите список слотов.', {
          reason: result.reason
        });
      }

      return {
        status: 201,
        payload: {
          held: true,
          holdSeconds: result.holdSeconds,
          expiresAt: new Date(result.expiresAt).toISOString()
        }
      };
    },
    AUTH
  );

  /** Слот больше не нужен: клиент передумал или слот сгорел по таймеру. */
  router.delete(
    '/api/holds',
    async ({ db, body, req, session }) => {
      const data = validate(body, {
        masterId: { type: 'int', required: true, min: 1 },
        startsAt: { type: 'string', required: true, max: 32 }
      });

      const result = releaseHold({
        masterId: data.masterId,
        startsAt: data.startsAt,
        ownerKey: ownerKeyOf(session, req)
      });

      return { payload: { released: result.ok, reason: result.reason ?? null } };
    },
    AUTH
  );

  /** Продлить таймер на экране подтверждения. */
  router.post(
    '/api/holds/extend',
    async ({ db, body, req, session }) => {
      const data = validate(body, {
        masterId: { type: 'int', required: true, min: 1 },
        startsAt: { type: 'string', required: true, max: 32 }
      });

      const result = extendHold({
        masterId: data.masterId,
        startsAt: data.startsAt,
        ownerKey: ownerKeyOf(session, req)
      });

      if (!result.ok) {
        throw badRequest('Удержание слота истекло, выберите время заново.', { reason: result.reason });
      }

      return {
        payload: {
          held: true,
          holdSeconds: result.holdSeconds,
          expiresAt: new Date(result.expiresAt).toISOString()
        }
      };
    },
    AUTH
  );

  return router;
}

/** Ответ клиенту: имена вместо идентификаторов, UTC явно помечен. */
export function publicAppointment(appointment, timezone) {
  if (!appointment) return null;

  return {
    id: appointment.id,
    status: appointment.status,
    startsAt: appointment.starts_at,
    endsAt: appointment.ends_at,
    timezone,
    isOverride: appointment.is_override,
    notes: appointment.notes,
    cancelledAt: appointment.cancelled_at,
    cancelReason: appointment.cancel_reason,
    createdAt: appointment.created_at,
    master: appointment.master,
    client: appointment.client
      ? {
          id: appointment.client.id,
          name: appointment.client.name,
          phone: appointment.client.phone,
          email: appointment.client.email
        }
      : null,
    services: appointment.services.map((service) => ({
      id: service.id,
      name: service.name,
      durationMin: service.duration_min,
      priceRub: service.price_rub
    })),
    totalPriceRub: appointment.totalPriceRub,
    totalDurationMin: appointment.totalDurationMin
  };
}
