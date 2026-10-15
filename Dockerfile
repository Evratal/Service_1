# Инструкция сборки образа приложения.
#
# Что важно в этом файле:
#   * node:24-slim — та же мажорная версия Node, что и на компьютере
#     разработчика (v24.x). Встроенный модуль node:sqlite работает без
#     дополнительных флагов, поэтому нативный better-sqlite3 не нужен.
#   * Зависимостей у проекта нет (в package.json пустые dependencies),
#     поэтому установка пакетов в сборке не выполняется — образ маленький
#     и собирается быстро.
#   * Каталог базы /app/data создаётся заранее и на сервере подключается
#     томом: файл базы лежит снаружи контейнера и переживает пересборку.

FROM node:24-slim

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY migrations ./migrations

# Каталог под файл базы. На сервере к нему подключается том (volume).
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_FILE=/app/data/app.db

EXPOSE 3000

# Миграции применяются самим приложением при запуске (src/migrations.js).
CMD ["node", "src/server.js"]
