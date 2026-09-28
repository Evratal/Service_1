/**
 * Наполнение базы демонстрационными данными.
 *
 *   node scripts/seed.js           заполнить базу, если она пустая
 *   node scripts/seed.js --fresh   сначала пересоздать базу, затем заполнить
 *
 * Данные повторяют прототип: 6 услуг и 3 мастера с теми же наборами услуг,
 * чтобы демонстрация совпадала с картинками из Task_1.
 *
 * Пароли в базе не хранятся: скрипт хеширует их через scrypt, как это делает
 * сервис при регистрации. Одинаковый пароль у всех демо-пользователей —
 * это осознанное упрощение для проверки вручную.
 */

import { config } from '../src/config.js';
import { openDatabase, withTransaction } from '../src/db.js';
import { hashPassword, utcNow } from '../src/security.js';
import { formatUtc, utcToZonedParts, zonedToUtc } from '../src/time.js';

const FRESH = process.argv.includes('--fresh');
const TIMEZONE = 'Europe/Moscow';
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'Demo2026!';

const SALON = {
  name: 'TOP BRO',
  timezone: TIMEZONE,
  address: 'ул. Малая Бронная, 12, Москва',
  phone: '+7 495 000-00-00',
  work_start: '10:00',
  work_end: '22:00'
};

const SERVICES = [
  { name: 'Мужская стрижка', description: 'Стрижка, мытьё и укладка. Форма подбирается под рост волос и тип головы.', duration_min: 60, price_rub: 2500 },
  { name: 'Стрижка и борода', description: 'Комплексный визит: стрижка с укладкой и моделирование бороды с горячим полотенцем.', duration_min: 90, price_rub: 3800 },
  { name: 'Бритьё бороды', description: 'Бритьё бороды, уход за кожей, успокаивающий бальзам.', duration_min: 45, price_rub: 1800 },
  { name: 'Камуфляж седины', description: 'Мягкое окрашивание без аммиака: естественный цвет и чистый оттенок роста.', duration_min: 60, price_rub: 2200 },
  { name: 'Детская стрижка', description: 'Стрижка ребёнку до 12 лет, спокойный темп и терпение мастера.', duration_min: 45, price_rub: 1800 },
  { name: 'Уход за кожей головы', description: 'Диагностика, пилинг и массаж. Подходит для чувствительной кожи головы.', duration_min: 60, price_rub: 2400 }
];

// Наборы услуг мастеров — как в прототипе (prototype/assets/js/app.js).
const MASTERS = [
  {
    email: 'artem@topbro.ru',
    name: 'Артём Волков',
    specialization: 'Барбер · стаж 8 лет',
    bio: 'Классика и форма. Ведёт стрижки по форме лица, работает ножницами.',
    serviceIndexes: [0, 1, 2, 4]
  },
  {
    email: 'daniil@topbro.ru',
    name: 'Даниил Орлов',
    specialization: 'Мастер-барбер · стаж 5 лет',
    bio: 'Работает текстурой и камуфляжем. Ведёт сложные случаи с сильной сединой.',
    serviceIndexes: [0, 1, 2, 3]
  },
  {
    email: 'ilya@topbro.ru',
    name: 'Илья Соколов',
    specialization: 'Топ-стилист · стаж 11 лет',
    bio: 'Стрижки по форме лица, уход за кожей головы. Обучает остальных мастеров.',
    serviceIndexes: [0, 3, 5]
  }
];

const CLIENTS = [
  { email: 'anna@example.com', name: 'Анна Крылова', phone: '+7 916 000-00-01' },
  { email: 'oleg@example.com', name: 'Олег Тимофеев', phone: '+7 916 000-00-02' }
];

const ADMIN = { email: 'admin@topbro.ru', name: 'Администратор TOP BRO', phone: '+7 916 000-00-00' };

/** Ближайший будущий момент нужного дня недели в местном времени студии. */
function nextLocalMoment(weekday, hour, minute = 0) {
  const now = new Date();
  const today = utcToZonedParts(now, TIMEZONE);

  for (let week = 0; week < 8; week += 1) {
    const daysAhead = (weekday - today.weekday + 7) % 7 + week * 7;
    const moment = zonedToUtc(
      {
        year: today.year,
        month: today.month,
        day: today.day + daysAhead,
        hour,
        minute
      },
      TIMEZONE
    );
    // Отступ в час, чтобы демонстрационная запись не оказалась в прошлом.
    if (moment.getTime() > now.getTime() + 3600_000) return moment;
  }
  throw new Error('Не удалось вычислить ближайшую дату');
}

/** Пн–Сб 10:00–21:00, вс — выходной. Как в прототипе. */
function scheduleRows(masterId) {
  return [
    ...[1, 2, 3, 4, 5].map((weekday) => ({
      master_id: masterId,
      weekday,
      start_time: '10:00',
      end_time: '21:00',
      is_working: 1
    })),
    { master_id: masterId, weekday: 6, start_time: '10:00', end_time: '20:00', is_working: 1 },
    { master_id: masterId, weekday: 0, start_time: '10:00', end_time: '21:00', is_working: 0 }
  ];
}

async function seed() {
  const db = openDatabase();
  const now = utcNow();

  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (existing > 0 && !FRESH) {
    console.log('В базе уже есть пользователи — ничего не делаю.');
    console.log('Чтобы пересоздать базу: npm run db:reset');
    db.close();
    return;
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  const ids = withTransaction(db, () => {
    // --- Студия ---
    db.prepare(
      `INSERT INTO salon (id, name, timezone, address, phone, work_start, work_end)
       VALUES (1, ?, ?, ?, ?, ?, ?)`
    ).run(
      SALON.name,
      SALON.timezone,
      SALON.address,
      SALON.phone,
      SALON.work_start,
      SALON.work_end
    );

    // --- Услуги ---
    const insertService = db.prepare(
      `INSERT INTO services (name, description, duration_min, price_rub, is_active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`
    );
    const serviceIds = SERVICES.map((s) =>
      Number(insertService.run(s.name, s.description, s.duration_min, s.price_rub, now).lastInsertRowid)
    );

    // --- Пользователи ---
    const insertUser = db.prepare(
      `INSERT INTO users (email, password_hash, name, phone, is_active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`
    );
    const insertRole = db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)');

    const adminId = Number(
      insertUser.run(ADMIN.email, passwordHash, ADMIN.name, ADMIN.phone, now).lastInsertRowid
    );
    insertRole.run(adminId, 'admin');

    const clientIds = CLIENTS.map((c) => {
      const id = Number(insertUser.run(c.email, passwordHash, c.name, c.phone, now).lastInsertRowid);
      insertRole.run(id, 'client');
      return id;
    });

    const insertMaster = db.prepare(
      `INSERT INTO masters (user_id, specialization, bio, is_active) VALUES (?, ?, ?, 1)`
    );
    const insertMasterService = db.prepare(
      'INSERT INTO master_services (master_id, service_id) VALUES (?, ?)'
    );
    const insertSchedule = db.prepare(
      `INSERT INTO schedules (master_id, weekday, start_time, end_time, is_working)
       VALUES (?, ?, ?, ?, ?)`
    );

    const masterIds = MASTERS.map((m) => {
      const userId = Number(
        insertUser.run(m.email, passwordHash, m.name, m.phone ?? null, now).lastInsertRowid
      );
      // Мастер — тоже клиент сервиса: он может записаться к коллеге.
      insertRole.run(userId, 'client');
      insertRole.run(userId, 'master');

      const masterId = Number(insertMaster.run(userId, m.specialization, m.bio).lastInsertRowid);
      for (const index of m.serviceIndexes) insertMasterService.run(masterId, serviceIds[index]);
      for (const row of scheduleRows(masterId)) {
        insertSchedule.run(row.master_id, row.weekday, row.start_time, row.end_time, row.is_working);
      }
      return masterId;
    });

    // --- Демонстрационные записи и блокировка ---
    const insertAppointment = db.prepare(
      `INSERT INTO appointments
         (client_id, master_id, starts_at, ends_at, status, is_override, created_by, created_at, notes)
       VALUES (?, ?, ?, ?, 'booked', 0, ?, ?, ?)`
    );
    const insertAppointmentService = db.prepare(
      'INSERT INTO appointment_services (appointment_id, service_id) VALUES (?, ?)'
    );

    // Ближайший понедельник: две занятые позиции у первого мастера.
    const mondayNoon = nextLocalMoment(1, 12);
    const monday14 = nextLocalMoment(1, 14);
    const monday16 = nextLocalMoment(1, 16);

    const appointment1 = Number(
      insertAppointment.run(
        clientIds[0],
        masterIds[0],
        formatUtc(mondayNoon),
        formatUtc(new Date(mondayNoon.getTime() + SERVICES[0].duration_min * 60_000)),
        clientIds[0],
        now,
        'Первый визит, подскажите по уходу'
      ).lastInsertRowid
    );
    insertAppointmentService.run(appointment1, serviceIds[0]);

    const appointment2 = Number(
      insertAppointment.run(
        clientIds[1],
        masterIds[0],
        formatUtc(monday14),
        formatUtc(new Date(monday14.getTime() + SERVICES[1].duration_min * 60_000)),
        clientIds[1],
        now,
        'Стрижка и борода'
      ).lastInsertRowid
    );
    insertAppointmentService.run(appointment2, serviceIds[1]);

    const appointment3 = Number(
      insertAppointment.run(
        clientIds[0],
        masterIds[1],
        formatUtc(monday16),
        formatUtc(new Date(monday16.getTime() + SERVICES[2].duration_min * 60_000)),
        clientIds[0],
        now,
        null
      ).lastInsertRowid
    );
    insertAppointmentService.run(appointment3, serviceIds[2]);

    // Перерыв второго мастера — пример разовой блокировки time_blocks.
    db.prepare(
      `INSERT INTO time_blocks (master_id, starts_at, ends_at, reason, created_by, created_at)
       VALUES (?, ?, ?, 'Обед', ?, ?)`
    ).run(
      masterIds[1],
      formatUtc(nextLocalMoment(1, 13)),
      formatUtc(nextLocalMoment(1, 14)),
      adminId,
      now
    );

    return { adminId, clientIds, masterIds, serviceIds };
  });

  db.close();

  console.log('База заполнена демонстрационными данными.\n');
  console.log('Демо-пароль у всех пользователей:', DEMO_PASSWORD);
  console.log('  Вход в панель администратора: ', ADMIN.email);
  for (const master of MASTERS) console.log('  Мастер (клиент и мастер):   ', master.email);
  for (const client of CLIENTS) console.log('  Клиент:                    ', client.email);
  console.log(`\nУслуг: ${ids.serviceIds.length}, мастеров: ${ids.masterIds.length}, клиентов: ${ids.clientIds.length}.`);
}

seed().catch((error) => {
  console.error('Ошибка заполнения базы:', error.message);
  process.exit(1);
});
