/**
 * Наполнение базы демонстрационными данными студии «Ноготочки».
 *
 *   node scripts/seed.js           заполнить базу, если она пустая
 *   node scripts/seed.js --fresh   сначала пересоздать базу, затем заполнить
 *
 * Данные повторяют задание: 6 услуг, 3 мастера с разными графиками работы
 * и услугами, чтобы демонстрация совпадала с описанием студии.
 *
 * Пароли в базе не хранятся: скрипт хеширует их через scrypt, как это делает
 * сервис при регистрации. Одинаковый пароль у всех демо-пользователей —
 * это осознанное упрощение для проверки вручную.
 */

import { openDatabase, withTransaction } from '../src/db.js';
import { hashPassword, utcNow } from '../src/security.js';
import { formatUtc, utcToZonedParts, zonedToUtc } from '../src/time.js';

const FRESH = process.argv.includes('--fresh');
const TIMEZONE = 'Europe/Moscow';
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'Demo2026!';

const SALON = {
  name: 'Ноготочки',
  timezone: TIMEZONE,
  address: 'ул. Цветочная, 5, Москва',
  phone: '+7 495 123-45-67',
  work_start: '10:00',
  work_end: '20:00'
};

// Индекс услуги используется в наборе услуг мастера (serviceIndexes).
const SERVICES = [
  { name: 'Маникюр с покрытием гель-лаком', description: 'Классический маникюр с обработкой кутикулы и покрытием гель-лаком.', duration_min: 90, price_rub: 1800 },
  { name: 'Маникюр и педикюр', description: 'Комплексный визит: маникюр и педикюр с покрытием за один приём.', duration_min: 150, price_rub: 3200 },
  { name: 'Наращивание ногтей', description: 'Моделирование и укрепление ногтей, подбор формы и длины.', duration_min: 150, price_rub: 2800 },
  { name: 'Дизайн ногтей', description: 'Дополнение к покрытию: художественный дизайн. Увеличивает визит на 15–30 минут.', duration_min: 30, price_rub: 300 },
  { name: 'Коррекция и окрашивание бровей', description: 'Коррекция формы и окрашивание бровей краской.', duration_min: 40, price_rub: 1200 },
  { name: 'Ламинирование бровей', description: 'Укладка и питание бровей: долговременная форма и аккуратный вид.', duration_min: 60, price_rub: 1800 }
];

// Графики мастеров: дни недели (0 = воскресенье) и рабочие часы.
const MASTERS = [
  {
    email: 'anna@nogotochki.ru',
    name: 'Анна Ковалева',
    specialization: 'Мастер маникюра и педикюра · стаж 7 лет',
    bio: 'Аккуратный маникюр и стойкое покрытие. Ведёт дизайн и наращивание.',
    serviceIndexes: [0, 1, 2, 3],
    days: [2, 3, 4, 5],
    start: '10:00',
    end: '18:00'
  },
  {
    email: 'marina@nogotochki.ru',
    name: 'Марина Орлова',
    specialization: 'Мастер по бровям · стаж 5 лет',
    bio: 'Коррекция и окрашивание бровей, ламинирование. Подбирает форму под лицо.',
    serviceIndexes: [4, 5],
    days: [3, 4, 5, 6],
    start: '11:00',
    end: '20:00'
  },
  {
    email: 'elena@nogotochki.ru',
    name: 'Елена Смирнова',
    specialization: 'Универсальный мастер · стаж 9 лет',
    bio: 'Ногти и брови в одном визите. Работает с постоянными клиентами.',
    serviceIndexes: [0, 2, 4, 5],
    days: [2, 4, 6],
    start: '10:00',
    end: '19:00'
  }
];

const CLIENTS = [
  { email: 'irina@example.com', name: 'Ирина Петрова', phone: '+7 916 000-00-01' },
  { email: 'olga@example.com', name: 'Ольга Соколова', phone: '+7 916 000-00-02' },
  { email: 'daria@example.com', name: 'Дарья Волкова', phone: '+7 916 000-00-03' }
];

const ADMIN = { email: 'admin@nogotochki.ru', name: 'Администратор Ноготочки', phone: '+7 916 000-00-00' };

/** Ближайший будущий момент нужного дня недели в местном времени студии. */
function nextLocalMoment(weekday, hour, minute = 0) {
  const now = new Date();
  const today = utcToZonedParts(now, TIMEZONE);

  for (let week = 0; week < 8; week += 1) {
    const daysAhead = ((weekday - today.weekday + 7) % 7) + week * 7;
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

/** Семь строк графика мастера: рабочие дни по его расписанию, остальные — выходные. */
function scheduleRows(master, masterId) {
  const rows = [];
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    const working = master.days.includes(weekday);
    rows.push({
      master_id: masterId,
      weekday,
      start_time: working ? master.start : '10:00',
      end_time: working ? master.end : '11:00',
      is_working: working ? 1 : 0
    });
  }
  return rows;
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
      insertService.run(s.name, s.description, s.duration_min, s.price_rub, now).lastInsertRowid
    );

    // --- Пользователи ---
    const insertUser = db.prepare(
      `INSERT INTO users (email, password_hash, name, phone, is_active, created_at)
       VALUES (?, ?, ?, ?, 1, ?)`
    );
    const insertRole = db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)');

    const adminId = insertUser.run(ADMIN.email, passwordHash, ADMIN.name, ADMIN.phone, now).lastInsertRowid;
    insertRole.run(adminId, 'admin');

    const clientIds = CLIENTS.map((c) => {
      const id = insertUser.run(c.email, passwordHash, c.name, c.phone, now).lastInsertRowid;
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
      const userId = insertUser.run(m.email, passwordHash, m.name, null, now).lastInsertRowid;
      // Мастер — тоже клиент сервиса: он может записаться к коллеге.
      insertRole.run(userId, 'client');
      insertRole.run(userId, 'master');

      const masterId = insertMaster.run(userId, m.specialization, m.bio).lastInsertRowid;
      for (const index of m.serviceIndexes) insertMasterService.run(masterId, serviceIds[index]);
      for (const row of scheduleRows(m, masterId)) {
        insertSchedule.run(row.master_id, row.weekday, row.start_time, row.end_time, row.is_working);
      }
      return masterId;
    });

    // --- Демонстрационные записи (данные для тестирования, этап 4) ---
    const insertAppointment = db.prepare(
      `INSERT INTO appointments
         (client_id, master_id, starts_at, ends_at, status, is_override, created_by, created_at, notes)
       VALUES (?, ?, ?, ?, 'booked', 0, ?, ?, ?)`
    );
    const insertAppointmentService = db.prepare(
      'INSERT INTO appointment_services (appointment_id, service_id) VALUES (?, ?)'
    );

    // Ирина Петрова → Анна Ковалева, среда 10:00, маникюр с покрытием.
    const wednesday10 = nextLocalMoment(3, 10);
    const appointment1 = insertAppointment.run(
      clientIds[0],
      masterIds[0],
      formatUtc(wednesday10),
      formatUtc(new Date(wednesday10.getTime() + SERVICES[0].duration_min * 60_000)),
      clientIds[0],
      now,
      'Маникюр с покрытием'
    ).lastInsertRowid;
    insertAppointmentService.run(appointment1, serviceIds[0]);

    // Ольга Соколова → Марина Орлова, четверг 12:00, ламинирование бровей.
    const thursday12 = nextLocalMoment(4, 12);
    const appointment2 = insertAppointment.run(
      clientIds[1],
      masterIds[1],
      formatUtc(thursday12),
      formatUtc(new Date(thursday12.getTime() + SERVICES[5].duration_min * 60_000)),
      clientIds[1],
      now,
      null
    ).lastInsertRowid;
    insertAppointmentService.run(appointment2, serviceIds[5]);

    // Дарья Волкова → Елена Смирнова, вторник 14:00, наращивание ногтей.
    const tuesday14 = nextLocalMoment(2, 14);
    const appointment3 = insertAppointment.run(
      clientIds[2],
      masterIds[2],
      formatUtc(tuesday14),
      formatUtc(new Date(tuesday14.getTime() + SERVICES[2].duration_min * 60_000)),
      clientIds[2],
      now,
      null
    ).lastInsertRowid;
    insertAppointmentService.run(appointment3, serviceIds[2]);

    // Повторяющиеся блокировки: обед Анны по четвергам и личное время Марины
    // по пятницам. Действуют каждую неделю, поэтому хранятся в schedule_blocks.
    const insertScheduleBlock = db.prepare(
      `INSERT INTO schedule_blocks (master_id, weekday, start_time, end_time, reason)
       VALUES (?, ?, ?, ?, ?)`
    );
    insertScheduleBlock.run(masterIds[0], 4, '13:00', '14:00', 'Обед');
    insertScheduleBlock.run(masterIds[1], 5, '15:00', '17:00', 'Личное время');
    // Елена по графику работает в субботу, но на весь день стоит блокировка
    // «Выходной» — так блокировка перекрывает рабочий день графика.
    insertScheduleBlock.run(masterIds[2], 6, '00:00', '23:59', 'Выходной');

    // Разовая блокировка — пример time_blocks: санитарный час у Анны во вторник.
    db.prepare(
      `INSERT INTO time_blocks (master_id, starts_at, ends_at, reason, created_by, created_at)
       VALUES (?, ?, ?, 'Санитарный час', ?, ?)`
    ).run(
      masterIds[0],
      formatUtc(nextLocalMoment(2, 16)),
      formatUtc(nextLocalMoment(2, 17)),
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
