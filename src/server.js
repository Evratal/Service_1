/**
 * Точка входа: поднимает HTTP-сервер.
 *
 *   npm start     — обычный запуск
 *   npm run dev   — запуск с автоперезагрузкой при изменении файлов
 *
 * Порядок запуска важен: сначала проверяется, что миграции применены,
 * и только потом открывается порт. Иначе сервер поднимется с пустой базой
 * и начнёт отвечать 500 на всё подряд.
 */

import { createServer } from 'node:http';

import { config } from './config.js';
import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { pruneTokens } from './auth.js';
import { pruneLoginAttempts } from './repo/users.js';

const MIGRATION_CHECK = 'SELECT COUNT(*) AS n FROM schema_migrations';

function assertMigrated(db) {
  try {
    const { n } = db.prepare(MIGRATION_CHECK).get();
    if (n === 0) {
      throw new Error('В базе нет применённых миграций');
    }
  } catch (error) {
    console.error(`\nБаза не готова: ${error.message}`);
    console.error('Выполните:  npm run db:reset\n');
    process.exit(1);
  }
}

function main() {
  const db = openDatabase();
  assertMigrated(db);

  // Уборка при старте: просроченные токены и старый журнал попыток входа,
  // чтобы таблицы auth_tokens и login_attempts не росли бесконечно.
  pruneTokens(db);
  pruneLoginAttempts(db);

  const app = createApp({ db, publicDir: `${config.root}/public` });

  const server = createServer(app.handle);

  // Заголовок заранее: если клиент оборвёт соединение, сервер не будет
  // пытаться слать ответ в закрытый сокет.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  server.listen(config.port, () => {
    console.log(`\nTOP BRO — сервер запущен`);
    console.log(`  адрес:        http://localhost:${config.port}`);
    console.log(`  окружение:    ${config.nodeEnv}`);
    console.log(`  база:         ${config.dbFile}`);
    console.log(`\nМаршруты:`);
    for (const route of app.router.list()) console.log(`  ${route}`);
    console.log('');
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Порт ${config.port} уже занят. Смените PORT в .env.`);
      process.exit(1);
    }
    console.error('Ошибка сервера:', error.message);
    process.exit(1);
  });

  /**
   * Корректное завершение: сначала перестаём принимать новые соединения,
   * потом закрываем базу. Так ни один запрос не оборвётся на середине.
   */
  function shutdown(signal) {
    console.log(`\n${signal}: останавливаю сервер...`);
    server.close(() => {
      try {
        db.close();
      } catch {
        // База уже закрыта.
      }
      console.log('Сервер остановлен.');
      process.exit(0);
    });

    // Если кто-то не отпускает соединение, не ждём вечно.
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
