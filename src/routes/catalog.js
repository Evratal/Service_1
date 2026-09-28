/**
 * Публичные справочные маршруты и расчёт свободных слотов.
 *
 * Здесь нет авторизации: лендинг и календарь видны всем, в том числе гостю.
 * Но и здесь действует проверка — только входных данных, а не прав.
 */

import { badRequest, notFound } from '../errors.js';
import { isValidDateString } from '../time.js';
import { computeFreeSlots } from '../slots.js';
import { holdsForMaster } from '../holds.js';
import { parseIdList, ownerKeyOf, pathId } from './helpers.js';
import {
  getMaster,
  getSalon,
  listMasters,
  listServices,
  getSchedule
} from '../repo/catalog.js';

export function registerCatalogRoutes(router) {
  router.get('/api/salon', async ({ db }) => {
    const salon = getSalon(db);
    if (!salon) throw notFound('Студия не настроена. Выполните npm run seed.');

    return {
      payload: {
        name: salon.name,
        timezone: salon.timezone,
        address: salon.address,
        phone: salon.phone,
        workStart: salon.work_start,
        workEnd: salon.work_end
      }
    };
  });

  router.get('/api/services', async ({ db }) => {
    return {
      payload: {
        services: listServices(db, { onlyActive: true }).map(publicService)
      }
    };
  });

  router.get('/api/masters', async ({ db, query }) => {
    const serviceIds = parseIdList(query, 'serviceIds');
    const masters = listMasters(db, { serviceIds, onlyActive: true });

    return {
      payload: {
        masters: masters.map((master) => ({
          id: master.id,
          name: master.name,
          specialization: master.specialization,
          bio: master.bio,
          phone: master.phone,
          serviceIds: master.services.map((service) => service.id)
        }))
      }
    };
  });

  router.get('/api/masters/:id', async ({ db, params }) => {
    const id = pathId(params, 'id');
    if (id === null) throw badRequest('Некорректный идентификатор мастера.');

    const master = getMaster(db, id);
    if (!master || master.is_active !== 1) throw notFound('Мастер не найден.');

    return {
      payload: {
        id: master.id,
        name: master.name,
        specialization: master.specialization,
        bio: master.bio,
        phone: master.phone,
        services: master.services.map(publicService),
        schedule: getSchedule(db, master.id).map(publicSchedule)
      }
    };
  });

  /**
   * Свободные слоты мастера на дату.
   *
   * GET /api/masters/1/slots?date=2026-09-28&serviceIds=1,2
   *
   * Суммарная длительность берётся из услуг, поэтому клиент всегда видит
   * именно те окна, в которые поместится его набор услуг.
   */
  router.get('/api/masters/:id/slots', async ({ db, params, query, req, session }) => {
    const id = pathId(params, 'id');
    if (id === null) throw badRequest('Некорректный идентификатор мастера.');

    const date = query.get('date') ?? '';
    if (!isValidDateString(date)) {
      throw badRequest('Укажите дату в формате YYYY-MM-DD, например 2026-09-28.');
    }

    const serviceIds = parseIdList(query, 'serviceIds');
    const salon = getSalon(db);
    if (!salon) throw notFound('Студия не настроена. Выполните npm run seed.');

    // Свои удержания не вычитаем: клиент должен видеть выбранное им время
    // свободным для себя, даже если уже держит его.
    const holds = holdsForMaster(id, ownerKeyOf(session, req));

    const result = computeFreeSlots({
      db,
      masterId: id,
      date,
      timezone: salon.timezone,
      serviceIds,
      holds
    });

    return {
      payload: {
        masterId: id,
        date,
        timezone: salon.timezone,
        serviceIds,
        totalDurationMin: result.slots[0]?.durationMin ?? 0,
        slots: result.slots,
        count: result.total,
        reason: result.reason ?? null
      }
    };
  });
}

export function publicService(service) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    durationMin: service.duration_min,
    priceRub: service.price_rub
  };
}

export function publicSchedule(row) {
  return {
    weekday: row.weekday,
    startTime: row.start_time,
    endTime: row.end_time,
    isWorking: Boolean(row.is_working)
  };
}
