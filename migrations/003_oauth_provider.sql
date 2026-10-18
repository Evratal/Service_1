-- 003_oauth_provider.sql — вход через внешний сервис (Яндекс).
--
-- Добавляем к пользователю признак внешнего входа: provider (какой сервис)
-- и provider_id (идентификатор пользователя в этом сервисе).
--
-- Почему ALTER TABLE, а не пересоздание таблицы: на users ссылаются внешними
-- ключами user_roles, masters, appointments, time_blocks и auth_tokens.
-- Пересоздание потребовало бы DROP TABLE users, а это каскадно удалило бы
-- связанные данные. PRAGMA foreign_keys внутри транзакции не отключается,
-- поэтому безопасный путь — добавить колонки на месте.
--
-- У пользователей, входящих по паролю, provider и provider_id остаются NULL.
-- Для входа через провайдера пароль не задаётся: в password_hash пишется
-- пустая строка (колонка объявлена NOT NULL), а вход по паролю для такого
-- аккаунта отсекается в маршруте входа.

ALTER TABLE users ADD COLUMN provider TEXT;
ALTER TABLE users ADD COLUMN provider_id TEXT;

-- Один внешний аккаунт = одна запись users. Частичный индекс не мешает
-- обычным пользователям: у них provider_id = NULL и в индекс не попадает.
CREATE UNIQUE INDEX idx_users_provider_identity
  ON users (provider, provider_id)
  WHERE provider_id IS NOT NULL;
