/**
 * Сборка приложения: маршруты, разбор запроса, обработка ошибок.
 *
 * createApp возвращает функцию handle(req, res) — обычный обработчик
 * node:http. Сервер (src/server.js) ничего не знает про маршруты, поэтому
 * те же самые проверки можно прогнать в тестах, не поднимая порт.
 */

import { config } from './config.js';
import { createRouter } from './router.js';
import { createStaticHandler } from './static.js';
import { HttpError, notFound } from './errors.js';
import { readJsonBody, sendError, sendJson } from './http.js';
import { optionalSession, requireSession } from './auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCatalogRoutes } from './routes/catalog.js';
import { registerAppointmentRoutes } from './routes/appointments.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerAdminRoutes } from './routes/admin.js';

/**
 * Заголовки безопасности на каждый ответ.
 *
 * Content-Security-Policy запрещает странице подключать чужие скрипты:
 * даже если атакующий сумеет подставить свой код в страницу, браузер не даст
 * ему выполнить произвольный скрипт с чужого адреса.
 * frame-ancestors 'none' запрещает встраивать сайт в iframe на phishing-сайте.
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
};

const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * @param {object} params
 * @param {import('node:sqlite').DatabaseSync} params.db
 * @param {string} [params.publicDir] каталог клиентской части
 */
export function createApp({ db, publicDir = 'public' }) {
  const router = createRouter();
  registerAuthRoutes(router);
  registerCatalogRoutes(router);
  registerAppointmentRoutes(router);
  registerNotificationRoutes(router);
  registerAdminRoutes(router);

  const serveStatic = createStaticHandler(publicDir);

  async function handleApi(req, res, url) {
    const { handler, params, options } = router.match(req.method, url.pathname);

    // Авторизация проверяется ДО чтения тела запроса: неавторизованному
    // клиенту не нужно тратить ресурсы на разбор большого JSON.
    // Маршруты с опцией auth требуют вход; остальным сессия нужна только
    // для индивидуальной настройки ответа (например, свои удержания слотов).
    const session = options.auth ? requireSession(db, req) : optionalSession(db, req);

    const body =
      METHODS_WITH_BODY.has(req.method) ? await readJsonBody(req) : {};

    const result = await handler({
      req,
      res,
      db,
      params,
      query: url.searchParams,
      session,
      body,
      url
    });

    const status = result?.status ?? 200;
    const payload = result?.payload ?? null;

    if (status === 204) {
      res.writeHead(204, { ...SECURITY_HEADERS });
      res.end();
      return;
    }

    sendJson(res, status, payload);
  }

  async function handle(req, res) {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }

    let url;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      sendError(res, new HttpError(400, 'bad_request', 'Некорректный адрес запроса.'));
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      sendError(res, new HttpError(400, 'bad_request', 'Некорректный адрес запроса.'));
      return;
    }

    try {
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }

      if (await serveStatic(req, res, pathname)) return;

      // Неизвестный адрес: если это похоже на запрос страницы, отдаём клиентскую
      // часть, чтобы работали красивые адреса и перезагрузка страницы.
      if (!pathname.includes('.') && (await serveStatic(req, res, '/index.html'))) return;

      sendError(res, notFound(`Адрес ${pathname} не найден.`));
    } catch (error) {
      sendError(res, error);
    }
  }

  return { handle, router };
}

export { SECURITY_HEADERS };
export default createApp;
