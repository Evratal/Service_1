/**
 * Маршруты уведомлений.
 *
 * Все маршруты требуют входа: уведомления адресуются конкретному
 * пользователю. Отметить прочитанным можно только своё уведомление —
 * проверка владельца выполняется в репозитории одним запросом.
 */

import { badRequest, notFound } from '../errors.js';
import { pathId } from './helpers.js';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadCount
} from '../repo/notifications.js';

const AUTH = { auth: true };

export function registerNotificationRoutes(router) {
  router.get(
    '/api/notifications',
    async ({ db, query, session }) => {
      const unreadOnly = query.get('unread') === '1';
      return {
        payload: {
          notifications: listNotifications(db, session.user.id, { unreadOnly })
        }
      };
    },
    AUTH
  );

  router.get(
    '/api/notifications/unread-count',
    async ({ db, session }) => {
      return { payload: { count: unreadCount(db, session.user.id) } };
    },
    AUTH
  );

  router.post(
    '/api/notifications/:id/read',
    async ({ db, params, session }) => {
      const id = pathId(params, 'id');
      if (id === null) throw badRequest('Некорректный идентификатор уведомления.');

      if (!markNotificationRead(db, id, session.user.id)) {
        throw notFound('Уведомление не найдено.');
      }

      return { payload: { ok: true } };
    },
    AUTH
  );

  router.post(
    '/api/notifications/read-all',
    async ({ db, session }) => {
      markAllNotificationsRead(db, session.user.id);
      return { payload: { ok: true } };
    },
    AUTH
  );

  return router;
}