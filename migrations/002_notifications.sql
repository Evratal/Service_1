-- ==========================================================================
-- 002_notifications.sql — уведомления пользователей.
--
-- Уведомление появляется, когда администратор меняет запись клиента:
-- отменяет, переносит или создаёт её поверх занятого времени. Клиент видит
-- счётчик непрочитанных в шапке и список на странице «Уведомления».
--
-- kind — короткий код события, title — заголовок, message — готовый текст
-- для показа. Текст собирается на сервере, чтобы клиент не придумывал
-- формулировки сам.
-- ==========================================================================

CREATE TABLE notifications (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  appointment_id INTEGER REFERENCES appointments (id) ON DELETE SET NULL,
  kind           TEXT    NOT NULL CHECK (kind IN (
                     'appointment_created',
                     'appointment_cancelled',
                     'appointment_rescheduled',
                     'appointment_override'
                   )),
  title          TEXT    NOT NULL,
  message        TEXT    NOT NULL,
  is_read        INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
  created_at     TEXT    NOT NULL
);

CREATE INDEX idx_notifications_user_time
  ON notifications (user_id, created_at);

CREATE INDEX idx_notifications_user_read
  ON notifications (user_id, is_read);