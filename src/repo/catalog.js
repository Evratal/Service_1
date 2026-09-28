/**
 * Доступ к справочным данным: студия, услуги, мастера, расписание.
 *
 * Это публичная часть сервиса — её видит любой посетитель сайта, поэтому
 * запросы здесь не фильтруются по пользователю.
 */

export function getSalon(db) {
  return db.prepare('SELECT * FROM salon WHERE id = 1').get() ?? null;
}

export function listServices(db, { onlyActive = true } = {}) {
  const where = onlyActive ? 'WHERE is_active = 1' : '';
  return db.prepare(`SELECT * FROM services ${where} ORDER BY name`).all();
}

export function getService(db, id) {
  return db.prepare('SELECT * FROM services WHERE id = ?').get(id) ?? null;
}

/**
 * Услуги по списку идентификаторов. Возвращает только те, что найдены и активны.
 * Порядок сохраняется, чтобы ответ совпадал с порядком на экране.
 */
export function servicesByIds(db, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM services WHERE id IN (${placeholders}) AND is_active = 1`)
    .all(...ids);

  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/**
 * Мастера, у которых есть ВСЕ перечисленные услуги.
 *
 * Именно «все», а не «хотя бы одна»: клиент отметил стрижку и камуфляж,
 * и мастер, который делает только стрижку, попасть в список не должен.
 */
export function listMasters(db, { serviceIds = [], onlyActive = true } = {}) {
  const masters = db
    .prepare(
      `SELECT m.id, m.user_id, m.specialization, m.bio, m.is_active,
              u.name, u.phone
         FROM masters m
         JOIN users u ON u.id = m.user_id
        WHERE (? = 0 OR m.is_active = 1)
        ORDER BY u.name`
    )
    .all(onlyActive ? 1 : 0);

  if (serviceIds.length === 0) return masters.map((master) => ({ ...master, services: servicesOfMaster(db, master.id) }));

  const placeholders = serviceIds.map(() => '?').join(',');
  const fitting = new Set(
    db
      .prepare(
        `SELECT master_id
           FROM master_services
          WHERE service_id IN (${placeholders})
          GROUP BY master_id
         HAVING COUNT(DISTINCT service_id) = ?`
      )
      .all(...serviceIds, serviceIds.length)
      .map((row) => row.master_id)
  );

  return masters
    .filter((master) => fitting.has(master.id))
    .map((master) => ({ ...master, services: servicesOfMaster(db, master.id) }));
}

export function getMaster(db, id) {
  const master = db
    .prepare(
      `SELECT m.id, m.user_id, m.specialization, m.bio, m.is_active, u.name, u.phone
         FROM masters m
         JOIN users u ON u.id = m.user_id
        WHERE m.id = ?`
    )
    .get(id);
  if (!master) return null;
  return { ...master, services: servicesOfMaster(db, id) };
}

export function servicesOfMaster(db, masterId) {
  return db
    .prepare(
      `SELECT s.*
         FROM master_services ms
         JOIN services s ON s.id = ms.service_id
        WHERE ms.master_id = ? AND s.is_active = 1
        ORDER BY s.name`
    )
    .all(masterId);
}

/** График мастера по дням недели, 0 — воскресенье. */
export function getSchedule(db, masterId) {
  return db
    .prepare('SELECT * FROM schedules WHERE master_id = ? ORDER BY weekday')
    .all(masterId);
}

/** Заменяет график мастера целиком. Использует только администратор. */
export function replaceSchedule(db, masterId, rows) {
  const insert = db.prepare(
    'INSERT INTO schedules (master_id, weekday, start_time, end_time, is_working) VALUES (?, ?, ?, ?, ?)'
  );
  for (const row of rows) {
    insert.run(masterId, row.weekday, row.start_time, row.end_time, row.is_working ? 1 : 0);
  }
}

export function listTimeBlocks(db, masterId, fromIso, toIso) {
  return db
    .prepare(
      `SELECT * FROM time_blocks
        WHERE master_id = ? AND starts_at < ? AND ends_at > ?
        ORDER BY starts_at`
    )
    .all(masterId, toIso, fromIso);
}
