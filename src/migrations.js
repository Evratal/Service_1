/**
 * Применение миграций к базе данных.
 *
 * Один и тот же код используется в двух местах:
 *   * при запуске приложения (src/server.js) — на сервере применять миграции
 *     руками некому, поэтому это делает само приложение до того, как начнёт
 *     отвечать на запросы;
 *   * вручную (scripts/migrate.js) — при разработке и для пересоздания базы.
 *
 * Каждая применённая миграция записывается в таблицу schema_migrations,
 * поэтому повторный запуск ничего не делает. Порядок определяется именем файла.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { config } from './config.js';

const MIGRATIONS_DIR = resolve(config.root, 'migrations');

/** Удаляет файл базы вместе со служебными файлами журнала WAL (флаг --fresh). */
export function removeDatabaseFiles(file) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const target = `${file}${suffix}`;
    if (existsSync(target)) rmSync(target);
  }
}

/** Файлы миграций .sql в порядке применения. */
export function listMigrationFiles() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * Применяет неприменённые миграции.
 *
 * Возвращает список имён применённых миграций (пустой, если применять нечего).
 * Если миграция падает, изменения откатываются, а ошибка пробрасывается —
 * приложение не должно подниматься с неполной схемой.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string[]}
 */
export function applyMigrations(db) {
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

  const done = [];
  for (const name of listMigrationFiles()) {
    if (applied.has(name)) continue;

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
      throw new Error(`Ошибка применения миграции ${name}: ${error.message}`);
    }

    done.push(name);
  }

  return done;
}

export { MIGRATIONS_DIR };
