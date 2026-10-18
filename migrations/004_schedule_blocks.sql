-- ==========================================================================
-- 004_schedule_blocks.sql — повторяющиеся блокировки времени в графике.
--
-- В отличие от time_blocks (разовые: отпуск, санитарный день), эта таблица
-- описывает блокировки, повторяющиеся каждую неделю в один и тот же день:
-- обед мастера или личное время. Задание студии «Ноготочки» задаёт именно
-- такие блокировки: Анна — четверг 13:00–14:00, Марина — пятница 15:00–17:00.
--
-- Время местное (часовой пояс салона), формат HH:MM, как в schedules.
-- ==========================================================================

CREATE TABLE schedule_blocks (
  id         INTEGER PRIMARY KEY,
  master_id  INTEGER NOT NULL REFERENCES masters (id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = воскресенье
  start_time TEXT    NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time   TEXT    NOT NULL CHECK (end_time   GLOB '[0-2][0-9]:[0-5][0-9]'),
  reason     TEXT,
  CHECK (end_time > start_time)
);

CREATE INDEX idx_schedule_blocks_master_weekday
  ON schedule_blocks (master_id, weekday);
