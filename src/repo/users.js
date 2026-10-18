/**
 * Доступ к данным пользователей.
 *
 * Здесь нет правил и проверок прав — только запросы к базе. Логика живёт
 * в маршрутах, а этот слой отвечает за то, чтобы SQL был в одном месте.
 */

import { conflict, tooManyRequests } from '../errors.js';
import { config } from '../config.js';
import { utcNow } from '../security.js';

export function findByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) ?? null;
}

export function findById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

/** Находит пользователя по внешней учётной записи (провайдер + его id). */
export function findByProvider(db, provider, providerId) {
  return (
    db
      .prepare('SELECT * FROM users WHERE provider = ? AND provider_id = ?')
      .get(provider, String(providerId)) ?? null
  );
}

/**
 * Находит или заводит пользователя для входа через внешний сервис.
 *
 * Порядок поиска:
 *   1. по внешней учётной записи — повторный вход в тот же аккаунт;
 *   2. по e-mail — привязываем внешний вход к уже существующему аккаунту;
 *   3. иначе создаём нового клиента без пароля.
 *
 * Заблокированный аккаунт не привязывается и возвращается как есть —
 * решение о показе ошибки принимает маршрут.
 */
export function upsertExternalUser(db, { provider, providerId, email, name }) {
  const linked = findByProvider(db, provider, providerId);
  if (linked) return linked;

  const existing = findByEmail(db, email);
  if (existing) {
    if (existing.is_active !== 1) return existing;
    db.prepare('UPDATE users SET provider = ?, provider_id = ? WHERE id = ?').run(
      provider,
      String(providerId),
      existing.id
    );
    return findById(db, existing.id);
  }

  const now = utcNow();
  const userId = Number(
    db
      .prepare(
        `INSERT INTO users (email, password_hash, name, phone, is_active, created_at, provider, provider_id)
         VALUES (?, '', ?, NULL, 1, ?, ?, ?)`
      )
      .run(email.toLowerCase(), name, now, provider, String(providerId)).lastInsertRowid
  );

  db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)').run(userId, 'client');
  return findById(db, userId);
}

export function rolesOf(db, userId) {
  return db
    .prepare('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role')
    .all(userId)
    .map((row) => row.role);
}

/** Идентификатор профиля мастера для пользователя, либо null. */
export function masterIdForUser(db, userId) {
  const row = db.prepare('SELECT id FROM masters WHERE user_id = ?').get(userId);
  return row ? row.id : null;
}

/** Клиенты для выбора в административном разделе при записи. */
export function listClientsForAdmin(db) {
  return db
    .prepare(
      `SELECT DISTINCT u.id, u.email, u.name, u.phone
         FROM users u
         JOIN user_roles r ON r.user_id = u.id AND r.role = 'client'
        WHERE u.is_active = 1
        ORDER BY u.name`
    )
    .all();
}

/** Обновляет имя и/или телефон в профиле пользователя. */
export function updateUserProfile(db, id, { name, phone }) {
  const sets = [];
  const values = [];

  if (name !== undefined) {
    sets.push('name = ?');
    values.push(name);
  }
  if (phone !== undefined) {
    sets.push('phone = ?');
    values.push(phone ?? null);
  }

  if (sets.length > 0) {
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }
  return findById(db, id);
}

/**
 * Создаёт пользователя с ролью клиента.
 *
 * Список ролей передаётся только для служебных нужд (seed). Значение role
 * из тела запроса сюда не попадает: роль назначает сервер, поэтому клиент
 * не может зарегистрироваться администратором.
 */
export function createUser(db, { email, passwordHash, name, phone = null, roles = ['client'] }) {
  const existing = findByEmail(db, email);
  if (existing) {
    throw conflict('email_taken', 'Пользователь с таким e-mail уже зарегистрирован.');
  }

  const now = utcNow();
  const userId = Number(
    db
      .prepare(
        `INSERT INTO users (email, password_hash, name, phone, is_active, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`
      )
      .run(email.toLowerCase(), passwordHash, name, phone, now).lastInsertRowid
  );

  const insertRole = db.prepare('INSERT INTO user_roles (user_id, role) VALUES (?, ?)');
  for (const role of roles) insertRole.run(userId, role);

  return findById(db, userId);
}

/** Публичное представление пользователя: без хеша пароля. */
export function publicUser(user, roles, masterId = null) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone ?? null,
    roles,
    masterId
  };
}

/* ---------------------------------------------------------------- попытки входа */

export function logAttempt(db, { email, ip, succeeded }) {
  db.prepare('INSERT INTO login_attempts (email, ip, succeeded, created_at) VALUES (?, ?, ?, ?)').run(
    email.toLowerCase(),
    ip ?? null,
    succeeded ? 1 : 0,
    utcNow()
  );
}

/** Сколько неудачных попыток входа было за последнее окно. */
export function failedAttemptsSince(db, email, minutes) {
  const since = new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM login_attempts
        WHERE email = ? AND succeeded = 0 AND created_at > ?`
    )
    .get(email.toLowerCase(), since);
  return row.n;
}

/**
 * Проверяет, не исчерпан ли лимит попыток входа.
 *
 * Защита от подбора пароля перебором. Окно скользящее: считаются попытки
 * за последние N минут, а не «с начала суток».
 */
export function assertLoginAllowed(db, email) {
  const failed = failedAttemptsSince(db, email, config.rateLimitWindowMin);
  if (failed >= config.rateLimitAttempts) {
    const minutes = config.rateLimitWindowMin;
    throw tooManyRequests(`Слишком много неудачных попыток входа. Повторите через ${minutes} минут.`, {
      retryAfterMinutes: minutes
    });
  }
}

/** После успешного входа счётчик неудачных попыток обнуляется. */
export function clearFailedAttempts(db, email) {
  db.prepare('DELETE FROM login_attempts WHERE email = ? AND succeeded = 0').run(email.toLowerCase());
}

/**
 * Ограничение числа регистраций с одного адреса.
 *
 * Та же таблица попыток входа используется как счётчик: отдельная таблица
 * ради одного числа была бы лишней. Ключ помечен префиксом, чтобы записи
 * о регистрации не смешивались с записями о входе по e-mail.
 */
export function assertRegisterAllowed(db, ip) {
  if (!ip) return;

  const key = `register:${ip}`;
  const since = new Date(Date.now() - config.rateLimitWindowMin * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const row = db
    .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND succeeded = 0 AND created_at > ?')
    .get(key, since);

  if (row.n >= config.rateLimitAttempts) {
    throw tooManyRequests('Слишком много регистраций с этого адреса. Попробуйте позже.', {
      retryAfterMinutes: config.rateLimitWindowMin
    });
  }
}

/** Считает неудачную регистрацию по адресу. */
export function logRegisterAttempt(db, ip) {
  if (!ip) return;
  db.prepare('INSERT INTO login_attempts (email, ip, succeeded, created_at) VALUES (?, ?, 0, ?)').run(
    `register:${ip}`,
    ip,
    utcNow()
  );
}

/**
 * Удаляет записи о попытках входа старше двух недель.
 *
 * Журнал служит только для подсчёта попыток за последние 15 минут; хранить
 * его вечно незачем, а каждая строка — это место на диске и лишняя работа
 * на всех выборках. Вызывается при старте сервера, как и уборка токенов.
 */
export function pruneLoginAttempts(db, keepDays = 14) {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  db.prepare('DELETE FROM login_attempts WHERE created_at < ? AND succeeded = 0').run(cutoff);
}
