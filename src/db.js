/**
 * Подключение к базе данных SQLite через встроенный модуль node:sqlite.
 *
 * Почему node:sqlite, а не better-sqlite3: better-sqlite3 — нативный модуль,
 * который собирается под конкретную версию Node.js и операционную систему.
 * При переносе проекта с Windows на VPS Beget его пришлось бы пересобирать.
 * node:sqlite входит в состав Node.js, поэтому на сервере ничего доустанавливать
 * не нужно.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from './config.js';

/**
 * Команда начала транзакции, которая СРАЗУ берёт блокировку на запись.
 *
 * Обычная транзакция (BEGIN, или BEGIN DEFERRED) сначала только читает данные
 * и берёт право на запись при первой инструкции изменения. В этот промежуток
 * между проверкой и вставкой успевает вклиниться второй запрос — это и есть
 * гонка при двойной записи. BEGIN IMMEDIATE закрывает эту щель.
 */
export const BEGIN_IMMEDIATE = 'BEGIN IMMEDIATE';

/**
 * Открывает базу и включает проверку внешних ключей.
 *
 * SQLite по умолчанию НЕ проверяет внешние ключи: база примет запись,
 * ссылающуюся на несуществующего мастера, и ошибка всплывёт позже и в другом
 * месте. Поэтому PRAGMA выполняется при каждом открытии, а не один раз
 * при запуске процесса.
 *
 * @param {string} [file] путь к файлу базы; ':memory:' — тестовая база в памяти
 * @returns {DatabaseSync}
 */
export function openDatabase(file = config.dbFile) {
  if (file !== ':memory:') {
    mkdirSync(dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file);

  // WAL: читатели не блокируют писателя. Помогает при одновременных запросах
  // к календарю и не даёт записи упираться в блокировку на чтении.
  db.exec('PRAGMA journal_mode = WAL');

  // Проверка внешних ключей — обязательна при каждом открытии.
  db.exec('PRAGMA foreign_keys = ON');

  // Ждать освобождения блокировки, а не сразу падать с SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 5000');

  return db;
}

/**
 * Выполняет функцию внутри транзакции BEGIN IMMEDIATE.
 *
 * Если функция бросила исключение, изменения откатываются. В частности так
 * откатывается вставка, отклонённая триггером защиты от двойной записи.
 *
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(db, fn) {
  db.exec(BEGIN_IMMEDIATE);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Откат может не понадобиться, если транзакция уже свёрнута
      // самой базой. Исходную ошибку не теряем.
    }
    throw error;
  }
}

export default openDatabase;
