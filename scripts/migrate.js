/**
 * Скрипт миграций: применяет файлы из migrations/ по порядку.
 *
 *   node scripts/migrate.js           применить новые миграции
 *   node scripts/migrate.js --fresh   удалить файл базы и создать заново
 *
 * На сервере этот скрипт запускать не нужно: приложение применяет миграции
 * само при старте (см. src/migrations.js). Скрипт остаётся для разработки
 * и для пересоздания базы на своём компьютере.
 *
 * Каждая применённая миграция записывается в таблицу schema_migrations,
 * поэтому повторный запуск ничего не делает. Порядок определяется именем файла.
 */

import { config } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { applyMigrations, listMigrationFiles, removeDatabaseFiles } from '../src/migrations.js';

const FRESH = process.argv.includes('--fresh');

function main() {
  if (FRESH) {
    removeDatabaseFiles(config.dbFile);
    console.log('Файл базы удалён, создаю заново.');
  }

  const db = openDatabase();

  const files = listMigrationFiles();
  if (files.length === 0) console.log('В migrations/ нет файлов .sql — нечего применять.');

  let applied;
  try {
    applied = applyMigrations(db);
  } catch (error) {
    console.error(error.message);
    db.close();
    process.exit(1);
  }

  for (const name of files) {
    const status = applied.includes(name) ? 'применена' : 'пропущена (уже применена)';
    console.log(`  ${status}: ${name}`);
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

  console.log(`\nГотово. Применено миграций: ${applied.length}.`);
  console.log(`База: ${config.dbFile}`);
  console.log(`Таблицы (${tables.length}): ${tables.join(', ')}`);
  console.log(`Триггеры (${triggers.length}): ${triggers.join(', ')}`);
}

main();
