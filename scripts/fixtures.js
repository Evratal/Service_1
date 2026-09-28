/**
 * Тестовые фикстуры: база в памяти с миграциями и минимальными данными.
 *
 * Общий модуль для scripts/check.js и scripts/check-api.js: обе проверки
 * должны видеть одинаковую базу, иначе «прошло в одной проверке» ничего
 * не значит.
 *
 * Рабочая база не затрагивается: всё живёт в памяти и исчезает с процессом.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { hashPassword, utcNow } from '../src/security.js';

const MIGRATIONS_DIR = resolve(config.root, 'migrations');

export const DEMO_PASSWORD = 'Demo2026!';
export const TIMEZONE = 'Europe/Moscow';

/** База в памяти с применёнными миграциями. */
export function freshTestDb() {
  const db = openDatabase(':memory:');
  for (const name of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    db.exec(readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8'));
  }
  return db;
}

/** Текст ошибки SQLite либо null, если ошибки не было. */
export function errorOf(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
}

/**
 * Наполняет базу данными для проверок.
 *
 * Студия работает ежедневно 10:00–20:00 по московскому времени, мастер
 * отдыхает в воскресенье. Часовой пояс и график выбраны так, чтобы в тестах
 * можно было однозначно посчитать ожидаемые слоты.
 */
export async function seedFixtures(db) {
  const now = utcNow();
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  db.prepare(
    'INSERT INTO salon (id, name, timezone, address, phone, work_start, work_end) VALUES (1, ?, ?, ?, ?, ?, ?)'
  ).run('TOP BRO', TIMEZONE, 'ул. Малая Бронная, 12', '+7 495 000-00-00', '10:00', '22:00');

  const insertService = db.prepare(
    'INSERT INTO services (name, description, duration_min, price_rub, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  );

  const serviceIds = [
    ['Мужская стрижка', 60, 2500],
    ['Стрижка и борода', 90, 3800],
    ['Бритьё бороды', 45, 1800]
  ].map(([name, duration, price]) =>
    Number(insertService.run(name, `${name}: описание`, duration, price, now).lastInsertRowid)
  );

  const insertUser = db.prepare(
    'INSERT INTO users (email, password_hash, name, phone, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  );
  const insertRole = db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)');

  const adminId = Number(
    insertUser.run('admin@topbro.ru', passwordHash, 'Администратор', '+7 916 000-00-00', now).lastInsertRowid
  );
  insertRole.run(adminId, 'admin');

  const insertClient = db.prepare(
    'INSERT INTO users (email, password_hash, name, phone, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)'
  );

  const clientIds = ['anna@example.com', 'oleg@example.com'].map((email, index) => {
    const id = Number(
      insertUser.run(email, passwordHash, index === 0 ? 'Анна Крылова' : 'Олег Тимофеев', null, now).lastInsertRowid
    );
    insertRole.run(id, 'client');
    return id;
  });

  const insertMaster = db.prepare(
    'INSERT INTO masters (user_id, specialization, bio, is_active) VALUES (?, ?, ?, 1)'
  );
  const insertMasterService = db.prepare(
    'INSERT INTO master_services (master_id, service_id) VALUES (?, ?)'
  );
  const insertSchedule = db.prepare(
    'INSERT INTO schedules (master_id, weekday, start_time, end_time, is_working) VALUES (?, ?, ?, ?, ?)'
  );

  // Мастер работает ежедневно 10:00–20:00, кроме воскресенья.
  const masterId = Number(
    insertMaster.run(clientIds[0], 'Барбер · стаж 8 лет', 'Классика и форма.').lastInsertRowid
  );

  // Первая «клиентка» оказалась мастером: добавляем ей обе роли.
  insertRole.run(clientIds[0], 'master');

  for (const serviceId of serviceIds) insertMasterService.run(masterId, serviceId);

  for (let weekday = 0; weekday < 7; weekday += 1) {
    insertSchedule.run(masterId, weekday, '10:00', '20:00', weekday === 0 ? 0 : 1);
  }

  return {
    adminId,
    clientIds,
    masterId,
    serviceIds,
    service60: serviceIds[0],
    service90: serviceIds[1],
    service45: serviceIds[2],
    password: DEMO_PASSWORD
  };
}
