/**
 * Конфигурация проекта.
 *
 * Загружает .env без внешних библиотек и отдаёт одно место, где читаются
 * настройки. Секреты лежат только в .env, который не попадает в репозиторий.
 * Перечень переменных с описаниями — в .env.example.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Минимальный разбор .env: KEY=VALUE, # — комментарий, кавычки снимаются. */
function loadEnvFile() {
  const file = resolve(ROOT, '.env');
  if (!existsSync(file)) return;

  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();

    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length > 1) value = value.slice(1, -1);

    // Реальное окружение процесса важнее файла: на сервере переменные
    // задаются системой, а не файлом.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

/** Число из окружения; при мусоре или отсутствии — значение по умолчанию. */
function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const config = {
  root: ROOT,
  nodeEnv,
  isProd: nodeEnv === 'production',

  port: num('PORT', 3000),
  dbFile: resolve(ROOT, process.env.DB_FILE ?? './data/app.db'),

  // Токен после входа живёт ограниченное время, в базе лежит только его хеш.
  tokenTtlHours: num('TOKEN_TTL_HOURS', 24),

  // Ограничение перебора пароля: неудачных попыток и размер окна в минутах.
  rateLimitAttempts: num('RATE_LIMIT_ATTEMPTS', 5),
  rateLimitWindowMin: num('RATE_LIMIT_WINDOW_MIN', 15),

  // Сколько секунд клиент держит выбранный слот, пока подтверждает запись.
  holdTtlSec: num('HOLD_TTL_SEC', 300),

  // Доверять ли заголовку X-Forwarded-For. 1 — только если сервер стоит за
  // своим прокси (nginx на Beget). Без этого заголовок можно подделать
  // и обойти лимиты попыток входа.
  trustProxy: (process.env.TRUST_PROXY ?? '0') === '1'
};

export default config;
