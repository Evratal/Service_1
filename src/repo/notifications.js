/**
 * Доступ к уведомлениям.
 *
 * Уведомление всегда адресовано конкретному пользователю: список читается
 * по user_id, и только владелец может отметить своё уведомление прочитанным.
 * Проверка владельца выполняется в SQL (WHERE ... AND user_id = ?), а не
 * после выборки, чтобы обход кода не открыл чужое уведомление.
 */

import { utcNow } from '../security.js';

export function createNotification(db, { userId, appointmentId = null, kind, title, message }) {
  const id = Number(
    db
      .prepare(
        `INSERT INTO notifications (user_id, appointment_id, kind, title, message, is_read, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      )
      .run(userId, appointmentId, kind, title, message, utcNow()).lastInsertRowid
  );

  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id);
}

/**
 * Список уведомлений пользователя, новые сверху.
 *
 * @param {object} db
 * @param {number} userId
 * @param {object} [params]
 * @param {boolean} [params.unreadOnly]
 * @param {number} [params.limit]
 */
export function listNotifications(db, userId, { unreadOnly = false, limit = 100 } = {}) {
  const conditions = ['user_id = ?'];
  const params = [userId];
  if (unreadOnly) conditions.push('is_read = 0');

  return db
    .prepare(
      `SELECT n.id, n.kind, n.title, n.message, n.is_read, n.created_at,
              a.starts_at AS appointment_starts_at
         FROM notifications n
         LEFT JOIN appointments a ON a.id = n.appointment_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT ?`
    )
    .all(...params, limit);
}

/** Сколько непрочитанных уведомлений у пользователя. */
export function unreadCount(db, userId) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0')
    .get(userId);
  return row.n;
}

/** Отмечает уведомление прочитанным. Возвращает false, если его нет или оно чужое. */
export function markNotificationRead(db, id, userId) {
  const result = db
    .prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(id, userId);
  return result.changes > 0;
}

/** Отмечает все уведомления пользователя прочитанными. */
export function markAllNotificationsRead(db, userId) {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(userId);
}