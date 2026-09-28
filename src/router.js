/**
 * Минимальный маршрутизатор.
 *
 * Поддерживает два вида маршрутов:
 *   /api/salon                — точное совпадение
 *   /api/masters/:id/slots    — именованный параметр
 *
 * Свой маршрутизатор вместо Express: у проекта нет зависимостей, а задача
 * требует, чтобы было видно, что происходит с каждым запросом. Здесь видно всё.
 */

import { HttpError, notFound } from './errors.js';

export function createRouter() {
  const routes = [];

  /** Превращает шаблон в регулярное выражение и список имён параметров. */
  function compile(pattern) {
    const names = [];
    const source = pattern
      .split('/')
      .map((segment) => {
        if (!segment.startsWith(':')) {
          return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }
        names.push(segment.slice(1));
        return '([^/]+)';
      })
      .join('/');

    return { regexp: new RegExp(`^${source}/?$`), names };
  }

  function add(method, pattern, handler, options = {}) {
    const { regexp, names } = compile(pattern);
    routes.push({ method, pattern, regexp, names, handler, options });
    return this;
  }

  /**
   * Ищет обработчик для метода и пути.
   *
   * Различает 404 (пути нет) и 405 (путь есть, но метод другой) — клиенту
   * полезно знать, что он обратился не туда, а не что ресурса не существует.
   *
   * @param {string} method
   * @param {string} pathname
   * @returns {{handler: Function, params: Record<string,string>, pattern: string, options: object}}
   */
  function match(method, pathname) {
    const wanted = method.toUpperCase();
    let pathExists = false;

    for (const route of routes) {
      const result = route.regexp.exec(pathname);
      if (!result) continue;

      pathExists = true;
      if (route.method !== wanted) continue;

      const params = {};
      route.names.forEach((name, index) => {
        params[name] = decodeURIComponent(result[index + 1]);
      });

      return { handler: route.handler, params, pattern: route.pattern, options: route.options };
    }

    if (pathExists) {
      throw new HttpError(405, 'method_not_allowed', `Метод ${wanted} не поддерживается для этого адреса.`);
    }
    throw notFound(`Адрес ${pathname} не найден.`);
  }

  return {
    add,
    get: (pattern, handler, options) => add.call(this, 'GET', pattern, handler, options),
    post: (pattern, handler, options) => add.call(this, 'POST', pattern, handler, options),
    patch: (pattern, handler, options) => add.call(this, 'PATCH', pattern, handler, options),
    put: (pattern, handler, options) => add.call(this, 'PUT', pattern, handler, options),
    delete: (pattern, handler, options) => add.call(this, 'DELETE', pattern, handler, options),

    match,

    /** Список маршрутов для отладочного вывода при старте. */
    list: () => routes.map((route) => `${route.method} ${route.pattern}${route.options.auth ? ' (нужен вход)' : ''}`)
  };
}

export default createRouter;
