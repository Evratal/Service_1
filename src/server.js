/**
 * Точка входа: поднимает HTTP-сервер.
 *
 *   npm start     — обычный запуск
 *   npm run dev   — запуск с автоперезагрузкой при изменении файлов
 *
 * Порядок запуска важен: сначала применяются миграции, и только потом
 * открывается порт. Иначе сервер поднимется с пустой базой и начнёт отвечать
 * 500 на всё подряд. На сервере применять миграции руками некому — обновление
 * приезжает само после коммита, поэтому приложение делает это при старте,
 * до того как начнёт отвечать на запросы.
 */

import { createServer } from 'node:http';

import { config } from './config.js';
import { openDatabase } from './db.js';
import { applyMigrations } from './migrations.js';
import { createApp } from './app.js';
import { pruneTokens } from './auth.js';
import { pruneLoginAttempts } from './repo/users.js';

function main() {
  const db = openDatabase();

  try {
    const applied = applyMigrations(db);
    if (applied.length > 0) {
      console.log(`Применено миграций: ${applied.length} (${applied.join(', ')}).`);
    }
  } catch (error) {
    console.error(`\nБаза не готова: ${error.message}\n`);
    db.close();
    process.exit(1);
  }

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
    console.log(`\nНоготочки — сервер запущен`);
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
