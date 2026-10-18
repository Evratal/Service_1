-- ==========================================================================
-- 001_init.sql — схема базы данных сервиса записи «Ноготочки»
-- Документ-основа: docs/db-schema.md
--
-- Файл выполняется один раз и пересоздаёт базу с нуля при выполнении
-- `npm run db:reset`. Отдельно от него создаются триггеры защиты
-- от двойной записи.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- salon — данные студии. Всегда ровно одна строка.
-- Настройки продукта хранятся здесь, а не в .env, потому что их меняет
-- администратор студии, а не разработчик.
-- --------------------------------------------------------------------------
CREATE TABLE salon (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  name        TEXT    NOT NULL,
  timezone    TEXT    NOT NULL,              -- IANA-зона, например Europe/Moscow
  address     TEXT    NOT NULL,
  phone       TEXT    NOT NULL,
  work_start  TEXT    NOT NULL CHECK (work_start GLOB '[0-2][0-9]:[0-5][0-9]'),
  work_end    TEXT    NOT NULL CHECK (work_end   GLOB '[0-2][0-9]:[0-5][0-9]'),
  CHECK (work_end > work_start)
);

-- --------------------------------------------------------------------------
-- users — пользователи: клиенты, мастера, администраторы.
-- Хранится только хеш пароля: исходный пароль восстановить нельзя.
-- --------------------------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  email         TEXT    NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  phone         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT    NOT NULL
);

-- --------------------------------------------------------------------------
-- user_roles — роли пользователя.
-- Отдельная таблица, а не список в поле: CHECK не даст записать
-- недопустимую роль, и проверка делается запросом EXISTS.
-- --------------------------------------------------------------------------
CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role    TEXT    NOT NULL CHECK (role IN ('client', 'master', 'admin')),
  PRIMARY KEY (user_id, role)
);

-- --------------------------------------------------------------------------
-- masters — профили мастеров. У одного пользователя профиль максимум один.
-- --------------------------------------------------------------------------
CREATE TABLE masters (
  id             INTEGER PRIMARY KEY,
  user_id        INTEGER NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  specialization TEXT    NOT NULL,
  bio            TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

-- --------------------------------------------------------------------------
-- services — услуги. Деньги хранятся целым числом рублей.
-- --------------------------------------------------------------------------
CREATE TABLE services (
  id           INTEGER PRIMARY KEY,
  name         TEXT    NOT NULL,
  description  TEXT,
  duration_min INTEGER NOT NULL CHECK (duration_min > 0),
  price_rub    INTEGER NOT NULL CHECK (price_rub >= 0),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   TEXT    NOT NULL
);

-- --------------------------------------------------------------------------
-- master_services — связь многие-ко-многим: мастер выполняет много услуг,
-- услугу выполняют много мастеров. Одним полем не выражается.
-- --------------------------------------------------------------------------
CREATE TABLE master_services (
  master_id  INTEGER NOT NULL REFERENCES masters (id)  ON DELETE CASCADE,
  service_id INTEGER NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  PRIMARY KEY (master_id, service_id)
);

-- --------------------------------------------------------------------------
-- schedules — регулярный график работы по дням недели.
-- Это НЕ слоты: строка отвечает на вопрос «когда мастер работает».
-- Свободное время вычисляется в момент запроса, см. docs/db-schema.md 5.1.
-- Время здесь местное (часовой пояс салона), в формате HH:MM.
-- --------------------------------------------------------------------------
CREATE TABLE schedules (
  id         INTEGER PRIMARY KEY,
  master_id  INTEGER NOT NULL REFERENCES masters (id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = воскресенье
  start_time TEXT    NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time   TEXT    NOT NULL CHECK (end_time   GLOB '[0-2][0-9]:[0-5][0-9]'),
  is_working INTEGER NOT NULL DEFAULT 1 CHECK (is_working IN (0, 1)),
  UNIQUE (master_id, weekday),
  CHECK (end_time > start_time)
);

-- --------------------------------------------------------------------------
-- time_blocks — разовые блокировки: обед, отпуск, санитарный день.
-- В отличие от schedules, действует один конкретный период, а не каждый день.
-- --------------------------------------------------------------------------
CREATE TABLE time_blocks (
  id         INTEGER PRIMARY KEY,
  master_id  INTEGER NOT NULL REFERENCES masters (id) ON DELETE CASCADE,
  starts_at  TEXT    NOT NULL,               -- UTC, YYYY-MM-DDTHH:MM:SSZ
  ends_at    TEXT    NOT NULL,
  reason     TEXT,
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT    NOT NULL,
  CHECK (ends_at > starts_at)
);

-- --------------------------------------------------------------------------
-- appointments — записи. Центральная таблица сервиса.
--
-- ends_at обязателен: без времени окончания сервис не знает, до какого
-- момента мастер занят, и не сможет посчитать свободные интервалы.
-- Статус — закрытый набор значений, свободный текст запрещён.
-- is_override — признак осознанного наложения, может выставить только admin.
-- Стоимости здесь нет: она вычисляется из цен услуг.
-- --------------------------------------------------------------------------
CREATE TABLE appointments (
  id             INTEGER PRIMARY KEY,
  client_id      INTEGER NOT NULL REFERENCES users (id),
  master_id      INTEGER NOT NULL REFERENCES masters (id),
  starts_at      TEXT    NOT NULL,           -- UTC
  ends_at        TEXT    NOT NULL,           -- UTC
  status         TEXT    NOT NULL CHECK (status IN (
                   'booked',
                   'completed',
                   'cancelled_by_client',
                   'cancelled_by_salon',
                   'no_show'
                 )),
  is_override    INTEGER NOT NULL DEFAULT 0 CHECK (is_override IN (0, 1)),
  created_by     INTEGER NOT NULL REFERENCES users (id),
  created_at     TEXT    NOT NULL,
  cancelled_at   TEXT,
  cancel_reason  TEXT,
  notes          TEXT,
  CHECK (ends_at > starts_at)
);

-- --------------------------------------------------------------------------
-- appointment_services — услуги, входящие в запись. Связь многие-ко-многим.
-- --------------------------------------------------------------------------
CREATE TABLE appointment_services (
  appointment_id INTEGER NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
  service_id     INTEGER NOT NULL REFERENCES services (id),
  PRIMARY KEY (appointment_id, service_id)
);

-- --------------------------------------------------------------------------
-- auth_tokens — токены доступа. В базе только хеш токена, сам токен
-- возвращается клиенту один раз при входе и больше не сохраняется.
-- --------------------------------------------------------------------------
CREATE TABLE auth_tokens (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,
  expires_at TEXT    NOT NULL,               -- UTC
  created_at TEXT    NOT NULL,
  revoked_at TEXT
);

-- --------------------------------------------------------------------------
-- login_attempts — журнал попыток входа для ограничения перебора пароля.
-- --------------------------------------------------------------------------
CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY,
  email      TEXT    NOT NULL,
  ip         TEXT,
  succeeded  INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  created_at TEXT    NOT NULL
);

-- ==========================================================================
-- Индексы
--
-- Без них расчёт свободного времени и проверка пересечений перебирали бы
-- таблицу записей целиком при каждом обращении к календарю.
-- ==========================================================================

CREATE INDEX idx_appointments_master_time
  ON appointments (master_id, starts_at);

CREATE INDEX idx_appointments_client_time
  ON appointments (client_id, starts_at);

CREATE INDEX idx_appointments_status
  ON appointments (status);

CREATE INDEX idx_time_blocks_master_time
  ON time_blocks (master_id, starts_at);

CREATE INDEX idx_schedules_master_weekday
  ON schedules (master_id, weekday);

CREATE INDEX idx_login_attempts_email_time
  ON login_attempts (email, created_at);

CREATE INDEX idx_auth_tokens_hash
  ON auth_tokens (token_hash);

-- ==========================================================================
-- Триггеры защиты от двойной записи
--
-- Условие пересечения интервалов: начало одного меньше конца другого,
-- а конец одного больше начала другого. Сравнение строгое, поэтому визиты
-- 15:00-16:00 и 16:00-17:00 стоящие вплотную конфликтом НЕ считаются.
--
-- Триггер пропускает:
--   * записи, у которых status <> 'booked' (отменённые слот не блокируют);
--   * записи с is_override = 1 (осознанное наложение администратора).
--
-- Это третий уровень защиты: проверка в API даёт понятный ответ клиенту,
-- транзакция BEGIN IMMEDIATE упорядочивает одновременные запросы, а триггер
-- даёт окончательную гарантию на момент записи — даже если вставить строку
-- в обход API.
-- ==========================================================================

CREATE TRIGGER appointments_no_overlap_insert
BEFORE INSERT ON appointments
FOR EACH ROW
WHEN NEW.status = 'booked' AND NEW.is_override = 0
BEGIN
  SELECT RAISE(ABORT, 'SLOT_CONFLICT')
  WHERE EXISTS (
    SELECT 1
    FROM appointments a
    WHERE a.master_id = NEW.master_id
      AND a.id <> NEW.id
      AND a.status = 'booked'
      AND a.starts_at < NEW.ends_at
      AND a.ends_at > NEW.starts_at
  );
END;

CREATE TRIGGER appointments_no_overlap_update
BEFORE UPDATE ON appointments
FOR EACH ROW
WHEN NEW.status = 'booked' AND NEW.is_override = 0
BEGIN
  SELECT RAISE(ABORT, 'SLOT_CONFLICT')
  WHERE EXISTS (
    SELECT 1
    FROM appointments a
    WHERE a.master_id = NEW.master_id
      AND a.id <> NEW.id
      AND a.status = 'booked'
      AND a.starts_at < NEW.ends_at
      AND a.ends_at > NEW.starts_at
  );
END;
