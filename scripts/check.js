/**
 * Самопроверка базы данных: проверяет, что защита на уровне схемы реально работает.
 *
 *   node scripts/check.js
 *
 * Скрипт НЕ трогает рабочую базу: он поднимает отдельную базу в памяти,
 * применяет к ней те же миграции и проверяет правила на ней. Так проверку
 * можно запускать в любой момент, не рискуя испортить данные.
 */

import { config } from '../src/config.js';
import { withTransaction } from '../src/db.js';
import { createToken, hashPassword, hashToken, utcNow, verifyPassword } from '../src/security.js';
import { formatUtc, parseHhMm, utcToZonedParts, zonedToUtc } from '../src/time.js';
import { errorOf, freshTestDb, seedFixtures } from './fixtures.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  OK    ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function insertAppointment(db, { clientId, masterId, start, end, status = 'booked', isOverride = 0, createdBy }) {
  return db
    .prepare(
      `INSERT INTO appointments (client_id, master_id, starts_at, ends_at, status, is_override, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(clientId, masterId, start, end, status, isOverride, createdBy, utcNow());
}

async function main() {
  console.log('Самопроверка базы данных «Ноготочки»');
  console.log(`Node ${process.version}, база в памяти, рабочая база не затрагивается.`);

  // ---------------------------------------------------------------- безопасность паролей
  section('Пароли и токены');

  const hash = await hashPassword('Demo2026!');
  check('хеш не содержит сам пароль', !hash.includes('Demo2026!'));
  check('в хеше есть отдельная соль для каждого хеша', hash !== (await hashPassword('Demo2026!')));
  check('правильный пароль подходит', await verifyPassword('Demo2026!', hash));
  check('неправильный пароль не подходит', !(await verifyPassword('Demo2027!', hash)));
  check('мусорный хеш не ломает проверку', (await verifyPassword('Demo2026!', 'нехеш')) === false);

  const token = createToken();
  check('токен достаточно длинный', token.length >= 40, `длина ${token.length}`);
  check('хеш токена детерминирован', hashToken(token) === hashToken(token));
  check('разные токены дают разные хеши', hashToken(token) !== hashToken(createToken()));

  // ---------------------------------------------------------------- внешние ключи
  section('Целостность связей');

  {
    const db = freshTestDb();
    const message = errorOf(() =>
      insertAppointment(db, {
        clientId: 1,
        masterId: 999,
        start: '2026-09-28T12:00:00Z',
        end: '2026-09-28T13:00:00Z',
        createdBy: 1
      })
    );
    check(
      'запись на несуществующего мастера отклонена',
      message !== null && /FOREIGN KEY/i.test(message),
      message ?? 'ошибки не было'
    );
    db.close();
  }

  {
    const db = freshTestDb();
    const message = errorOf(() =>
      db.prepare('INSERT INTO user_roles (user_id, role) VALUES (1, ?), (1, ?), (1, ?)').run('root', 'superuser', 'admin')
    );
    check('выдуманная роль отклонена ограничением CHECK', message !== null && /CHECK/i.test(message), message ?? 'ошибки не было');
    db.close();
  }

  {
    const db = freshTestDb();
    const message = errorOf(() =>
      db
        .prepare(
          `INSERT INTO services (name, duration_min, price_rub, is_active, created_at) VALUES ('Услуга', 0, 100, 1, ?)`
        )
        .run(utcNow())
    );
    check('нулевая длительность услуги отклонена', message !== null && /CHECK/i.test(message), message ?? 'ошибки не было');
    db.close();
  }

  // ---------------------------------------------------------------- защита от двойной записи
  section('Защита от двойной записи');

  const T = {
    first: { start: '2026-09-28T12:00:00Z', end: '2026-09-28T13:00:00Z' },
    inside: { start: '2026-09-28T12:30:00Z', end: '2026-09-28T13:30:00Z' },
    covering: { start: '2026-09-28T11:00:00Z', end: '2026-09-28T14:00:00Z' },
    before: { start: '2026-09-28T10:00:00Z', end: '2026-09-28T12:00:00Z' },
    touching: { start: '2026-09-28T13:00:00Z', end: '2026-09-28T14:00:00Z' },
    otherDay: { start: '2026-09-29T12:00:00Z', end: '2026-09-29T13:00:00Z' }
  };

  {
    const db = freshTestDb();
    const { clientIds, masterId } = await seedFixtures(db); const userId = clientIds[1];
    insertAppointment(db, { clientId: userId, masterId, start: T.first.start, end: T.first.end, createdBy: userId });

    const inside = errorOf(() =>
      insertAppointment(db, { clientId: userId, masterId, start: T.inside.start, end: T.inside.end, createdBy: userId })
    );
    check('запись внутри занятого интервала отклонена', inside !== null && /SLOT_CONFLICT/.test(inside), inside ?? 'ошибки не было');

    const covering = errorOf(() =>
      insertAppointment(db, { clientId: userId, masterId, start: T.covering.start, end: T.covering.end, createdBy: userId })
    );
    check('запись, полностью накрывающая занятый интервал, отклонена', covering !== null && /SLOT_CONFLICT/.test(covering), covering ?? 'ошибки не было');

    const before = errorOf(() =>
      insertAppointment(db, { clientId: userId, masterId, start: T.before.start, end: T.before.end, createdBy: userId })
    );
    check('запись, заканчивающаяся ровно в момент начала занятой, разрешена', before === null, before ?? '');

    const touching = errorOf(() =>
      insertAppointment(db, { clientId: userId, masterId, start: T.touching.start, end: T.touching.end, createdBy: userId })
    );
    check('визиты вплотную 12:00–13:00 и 13:00–14:00 не конфликтуют', touching === null, touching ?? '');

    const otherDay = errorOf(() =>
      insertAppointment(db, { clientId: userId, masterId, start: T.otherDay.start, end: T.otherDay.end, createdBy: userId })
    );
    check('то же время в другой день разрешено', otherDay === null, otherDay ?? '');

    const count = db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n;
    check('в базу попали только разрешённые записи', count === 4, `записей: ${count}`);
    db.close();
  }

  {
    const db = freshTestDb();
    const { clientIds, masterId } = await seedFixtures(db); const userId = clientIds[1];
    insertAppointment(db, { clientId: userId, masterId, start: T.first.start, end: T.first.end, createdBy: userId });

    const cancelled = errorOf(() =>
      insertAppointment(db, {
        clientId: userId,
        masterId,
        start: T.inside.start,
        end: T.inside.end,
        status: 'cancelled_by_client',
        createdBy: userId
      })
    );
    check('отменённая запись не блокирует слот', cancelled === null, cancelled ?? '');

    const completed = errorOf(() =>
      insertAppointment(db, {
        clientId: userId,
        masterId,
        start: T.inside.start,
        end: T.inside.end,
        status: 'completed',
        createdBy: userId
      })
    );
    check('завершённая запись не блокирует слот', completed === null, completed ?? '');

    const override = errorOf(() =>
      insertAppointment(db, {
        clientId: userId,
        masterId,
        start: T.inside.start,
        end: T.inside.end,
        isOverride: 1,
        createdBy: userId
      })
    );
    check('наложение с is_override = 1 разрешено', override === null, override ?? '');

    db.close();
  }

  {
    // Перенос записи. Проверяем, что триггер обновления ловит наложение
    // на ДРУГУЮ запись и при этом не путает запись с самой собой.
    const db = freshTestDb();
    const { clientIds, masterId } = await seedFixtures(db); const userId = clientIds[1];
    const a = insertAppointment(db, {
      clientId: userId,
      masterId,
      start: '2026-09-28T12:00:00Z',
      end: '2026-09-28T13:00:00Z',
      createdBy: userId
    });
    insertAppointment(db, {
      clientId: userId,
      masterId,
      start: '2026-09-28T15:00:00Z',
      end: '2026-09-28T16:00:00Z',
      createdBy: userId
    });

    const onTop = errorOf(() =>
      db
        .prepare('UPDATE appointments SET starts_at = ?, ends_at = ? WHERE id = ?')
        .run('2026-09-28T15:00:00Z', '2026-09-28T16:00:00Z', a.lastInsertRowid)
    );
    check('перенос существующей записи на время другой записи отклонён', onTop !== null && /SLOT_CONFLICT/.test(onTop), onTop ?? 'ошибки не было');

    const beside = errorOf(() =>
      db
        .prepare('UPDATE appointments SET starts_at = ?, ends_at = ? WHERE id = ?')
        .run('2026-09-28T14:00:00Z', '2026-09-28T15:00:00Z', a.lastInsertRowid)
    );
    check('перенос записи вплотную к другой разрешён', beside === null, beside ?? '');

    // Запись сдвигает сама себя и перекрывает своё прежнее время.
    // Сравнение a.id <> NEW.id исключает саму строку, поэтому такой перенос
    // не должен считаться конфликтом с самим собой.
    const selfOverlap = errorOf(() =>
      db
        .prepare('UPDATE appointments SET starts_at = ?, ends_at = ? WHERE id = ?')
        .run('2026-09-28T12:30:00Z', '2026-09-28T14:00:00Z', a.lastInsertRowid)
    );
    check('запись, перекрывающая сама себя после сдвига, не ложно конфликтует', selfOverlap === null, selfOverlap ?? '');

    const reverseTime = errorOf(() =>
      db.prepare('UPDATE appointments SET ends_at = ? WHERE id = ?').run('2026-09-28T12:00:00Z', a.lastInsertRowid)
    );
    check('визит без положительной длительности отклонён', reverseTime !== null && /CHECK/i.test(reverseTime), reverseTime ?? 'ошибки не было');

    db.close();
  }

  {
    // Откат транзакции: неудачная вставка не должна оставлять частичные данные.
    const db = freshTestDb();
    const { clientIds, masterId } = await seedFixtures(db); const userId = clientIds[1];
    const message = errorOf(() =>
      withTransaction(db, () => {
        insertAppointment(db, { clientId: userId, masterId, start: T.first.start, end: T.first.end, createdBy: userId });
        insertAppointment(db, { clientId: userId, masterId, start: T.inside.start, end: T.inside.end, createdBy: userId });
      })
    );
    check('конфликт внутри транзакции прерывает её', message !== null && /SLOT_CONFLICT/.test(message), message ?? 'ошибки не было');
    check('откат убрал обе записи', db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n === 0);
    db.close();
  }

  // ---------------------------------------------------------------- часовые пояса
  section('Часовые пояса');

  check('Москва, зима: 15:00 местных = 12:00Z', formatUtc(zonedToUtc({ year: 2026, month: 1, day: 15, hour: 15, minute: 0 })) === '2026-01-15T12:00:00Z');
  check('Москва, лето: 15:00 местных = 12:00Z', formatUtc(zonedToUtc({ year: 2026, month: 7, day: 15, hour: 15, minute: 0 })) === '2026-07-15T12:00:00Z');
  check('обратный перевод совпадает', utcToZonedParts(zonedToUtc({ year: 2026, month: 7, day: 15, hour: 15, minute: 30 })).time === '15:30');
  check('день недели понедельника = 1', utcToZonedParts(zonedToUtc({ year: 2026, month: 9, day: 28, hour: 12, minute: 0 })).weekday === 1);
  check('день недели воскресенья = 0', utcToZonedParts(zonedToUtc({ year: 2026, month: 9, day: 27, hour: 12, minute: 0 })).weekday === 0);
  check('«10:00» разбирается в 600 минут', parseHhMm('10:00') === 600);
  check('«24:00» не проходит разбор', parseHhMm('24:00') === null);
  check('«abc» не проходит разбор', parseHhMm('abc') === null);

  // ---------------------------------------------------------------- вычисляемые слоты
  section('Расписание');

  {
    const db = freshTestDb();
    const { masterId } = await seedFixtures(db);

    // Фикстура заполняет все семь дней недели. Здесь нужен чистый график,
    // поэтому удаляем его и проверяем ограничения с нуля.
    db.prepare('DELETE FROM schedules WHERE master_id = ?').run(masterId);

    const insertSchedule = db.prepare(
      'INSERT INTO schedules (master_id, weekday, start_time, end_time, is_working) VALUES (?, ?, ?, ?, ?)'
    );
    insertSchedule.run(masterId, 1, '10:00', '14:00', 1);
    insertSchedule.run(masterId, 0, '10:00', '14:00', 0);

    const monday = db.prepare('SELECT * FROM schedules WHERE master_id = ? AND weekday = 1').get(masterId);
    const sunday = db.prepare('SELECT * FROM schedules WHERE master_id = ? AND weekday = 0').get(masterId);

    check('график понедельника сохранён', monday.start_time === '10:00' && monday.end_time === '14:00');
    check('воскресенье помечено выходным', sunday.is_working === 0);

    const duplicate = errorOf(() =>
      db.prepare('INSERT INTO schedules (master_id, weekday, start_time, end_time, is_working) VALUES (?, 1, ?, ?, 1)').run(masterId, '09:00', '12:00')
    );
    check('второй график на тот же день недели отклонён', duplicate !== null, duplicate ?? 'ошибки не было');

    const reversed = errorOf(() =>
      db.prepare('INSERT INTO schedules (master_id, weekday, start_time, end_time, is_working) VALUES (?, 3, ?, ?, 1)').run(masterId, '18:00', '12:00')
    );
    check('график, где конец раньше начала, отклонён', reversed !== null && /CHECK/i.test(reversed), reversed ?? 'ошибки не было');

    db.close();
  }

  {
    const db = freshTestDb();
    const { masterId } = await seedFixtures(db);
    const bad = errorOf(() =>
      db
        .prepare('INSERT INTO time_blocks (master_id, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, 1, ?)')
        .run(masterId, '2026-09-28T12:00:00Z', '2026-09-28T11:00:00Z', utcNow())
    );
    check('блокировка с концом раньше начала отклонена', bad !== null && /CHECK/i.test(bad), bad ?? 'ошибки не было');
    db.close();
  }

  console.log(`\nИтог: успешно ${passed}, ошибок ${failed}.`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Самопроверка не завершилась:', error);
  process.exit(1);
});


