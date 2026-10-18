/**
 * Ответы и разбор запросов.
 *
 * Здесь нет фреймворка: Node.js умеет отдавать статику и парсить тело запроса.
 * Ручной разбор даёт то, что нам важно для безопасности:
 *   * ограничение размера тела запроса;
 *   * запрет неограниченного чтения тела в память;
 *   * единый формат ошибок;
 *   * запрет кэширования ответов API.
 */

import { HttpError, badRequest, serverError } from './errors.js';

/** Максимальный размер тела запроса: 32 КБ хватает для любой нашей формы. */
export const MAX_BODY_BYTES = 32 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

/**
 * Заголовки, запрещающие браузеру и прокси кэшировать ответ API.
 * В личном кабинете показ чужих записей из кэша — утечка данных.
 */
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0'
};

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload ?? null);

  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...NO_STORE_HEADERS,
    ...extraHeaders
  });
  res.end(body);
}

export function sendError(res, error) {
  // Внутренние ошибки не показываем клиенту: текст может содержать
  // названия файлов, SQL-запросы и структуру базы.
  if (error instanceof HttpError) {
    const payload = { error: { code: error.code, message: error.message } };
    if (error.details !== undefined) payload.error.details = error.details;
    return sendJson(res, error.status, payload);
  }

  console.error('Непойманная ошибка:', error);
  return sendJson(res, 500, { error: { code: 'server_error', message: serverError().message } });
}

/**
 * Читает тело запроса как JSON-объект.
 *
 * Что здесь важно:
 *   * размер ограничен, иначе один запрос может занять всю память сервера;
 *   * тело читается чанками, а не целиком, поэтому потоковое тело
 *     не переполняет буфер;
 *   * неверный JSON превращается в понятную ошибку 400, а не в 500.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<Record<string, unknown>>}
 */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new HttpError(413, 'payload_too_large', 'Тело запроса слишком большое.'));
      return;
    }

    const chunks = [];
    let size = 0;
    let finished = false;

    const fail = (error) => {
      if (finished) return;
      finished = true;
      req.destroy();
      reject(error);
    };

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new HttpError(413, 'payload_too_large', 'Тело запроса слишком большое.'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => fail(serverError('Не удалось прочитать тело запроса.')));

    req.on('end', () => {
      if (finished) return;
      finished = true;

      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolve({});
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(badRequest('Тело запроса должно быть корректным JSON.'));
        return;
      }

      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(badRequest('Тело запроса должно быть JSON-объектом.'));
        return;
      }

      resolve(parsed);
    });
  });
}

/**
 * Читает тело запроса как обычную форму (application/x-www-form-urlencoded).
 * Пригодится, если клиентская часть будет отправлять форму без JavaScript.
 */
export async function readFormBody(req, limit = MAX_BODY_BYTES) {
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload_too_large', 'Тело запроса слишком большое.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  return Object.fromEntries(new URLSearchParams(raw));
}

/** Тип содержимого по расширению файла. */
export function contentTypeFor(filePath) {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return CONTENT_TYPES[filePath.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

export { NO_STORE_HEADERS };
