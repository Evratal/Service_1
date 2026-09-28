/**
 * Скрипт миграций: применяет файлы из migrations/ по порядку.
 *
 *   node scripts/migrate.js           применить новые миграции
 *   node scripts/migrate.js --fresh   удалить файл базы и создать заново
 *
 * Каждая применённая миграция записывается в таблицу schema_migrations,
 * поэтому повторный запуск ничего не делает. Порядок определяется именем файла.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from '../src/config.js';
import { openDatabase } from '../src/db.js';

const FRESH = process.argv.includes('--fresh');
const MIGRATIONS_DIR = resolve(config.root, 'migrations');

/** Удаляет файл базы вместе со служебными файлами журнала WAL. */
function removeDatabaseFiles(file) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = `${file}${suffix}`;
    if (existsSync(target)) rmSync(target);
  }
}

function listMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function main() {
  if (FRESH) {
    removeDatabaseFiles(config.dbFile);
    console.log('Файл базы удалён, создаю заново.');
  }

  const db = openDatabase();

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((row) => row.name)
  );

  const files = listMigrations();
  if (files.length === 0) console.log('В migrations/ нет файлов .sql — нечего применять.');

  let count = 0;
  for (const name of files) {
    if (applied.has(name)) {
      console.log(`  пропущена (уже применена): ${name}`);
      continue;
    }

    const sql = readFileSync(resolve(MIGRATIONS_DIR, name), 'utf8');
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    // Каждая миграция применяется целиком или никак.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, now);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // База уже свёрнула транзакцию сама.
      }
      console.error(`Ошибка применения миграции ${name}: ${error.message}`);
      db.close();
      process.exit(1);
    }

    console.log(`  применена: ${name}`);
    count += 1;
  }

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);

  const triggers = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all()
    .map((row) => row.name);

  db.close();

  console.log(`\nГотово. Применено миграций: ${count}.`);
  console.log(`База: ${config.dbFile}`);
  console.log(`Таблицы (${tables.length}): ${tables.join(', ')}`);
  console.log(`Триггеры (${triggers.length}): ${triggers.join(', ')}`);
}

main();
