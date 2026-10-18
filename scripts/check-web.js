/**
 * Живая проверка: сервер стартует как настоящий процесс (src/server.js), на
 * временной базе, и по HTTP проходится весь сценарий клиента:
 *
 *   * отдаётся клиентская часть (index.html, шрифты, скрипты) со всеми
 *     заголовками безопасности;
 *   * регистрация → выбор слота → удержание → подтверждение записи;
 *   * второй клиент получает 409 при попытке занять тот же слот;
 *   * чужой клиент получает 403 на чужую запись;
 *   * после отмены слот снова свободен.
 *
 * Запуск:  node scripts/check-web.js
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.join(root, 'data', 'web-check.db');
const port = 3199;

function runChild(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out }));
  });
}

/** Подождать, пока сервер начнёт отвечать. */
async function waitUp(attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`http://localhost:${port}/api/salon`);
      if (res.ok) return true;
    } catch {
      // ещё не поднялся — пробуем снова
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK ' : 'ОШИБКА'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const dayName = (iso) => iso.slice(0, 10);

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

async function jsonRequest(base, method, pathText, body, token) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${pathText}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

async function main() {
  if (existsSync(dbFile)) rmSync(dbFile);

  console.log('Готовлю временную базу (migrate + seed)...');
  const migrated = await runChild(process.execPath, ['scripts/migrate.js', '--fresh'], { DB_FILE: dbFile });
  if (migrated.code !== 0) {
    console.error(migrated.out);
    process.exit(1);
  }
  const seeded = await runChild(process.execPath, ['scripts/seed.js'], { DB_FILE: dbFile });
  if (seeded.code !== 0) {
    console.error(seeded.out);
    process.exit(1);
  }

  console.log('Запускаю сервер...');
  const serverChild = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', DB_FILE: dbFile, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const serverExit = new Promise((resolve) => serverChild.on('exit', resolve));
  await waitUp();

  const base = `http://localhost:${port}`;

  /* ----- клиентская часть и статика ----- */
  const index = await fetch(`${base}/`);
  const indexText = await index.text();
  check('GET / отдаёт клиентскую часть', index.status === 200 && indexText.includes('Ноготочки'));
  check('CSP и X-Frame-Options на странице', index.headers.get('content-security-policy')?.includes("script-src 'self'") && index.headers.get('x-frame-options') === 'DENY');

  const appJs = await fetch(`${base}/assets/js/app.js`);
  check('GET /assets/js/app.js отдан', appJs.status === 200 && appJs.headers.get('content-type')?.includes('javascript'));
  const extraCss = await fetch(`${base}/assets/css/extra.css`);
  check('GET /assets/css/extra.css отдан', extraCss.status === 200);
  const spaFallback = await fetch(`${base}/ne/существует`);
  check('Неизвестный адрес отдаёт страницу (SPA)', spaFallback.status === 200 && spaFallback.headers.get('content-type')?.includes('text/html'));

  const unknownApi = await jsonRequest(base, 'GET', '/api/no-such-route');
  check('Неизвестный API-маршрут — 404 JSON', unknownApi.status === 404 && unknownApi.json.error.code === 'not_found');

  /* ----- данные каталога ----- */
  const salon = await jsonRequest(base, 'GET', '/api/salon');
  const services = await jsonRequest(base, 'GET', '/api/services');
  const masters = await jsonRequest(base, 'GET', '/api/masters');
  check('Каталог загружается', salon.status === 200 && services.status === 200 && masters.status === 200 && services.json.services.length > 0 && masters.json.masters.length > 0);

  const master = masters.json.masters[0];
  const firstService = services.json.services.find((s) => master.serviceIds.includes(s.id)) ?? services.json.services[0];

  /* ----- клиенты A и B ----- */
  const emailA = `clienta-${uid()}@example.com`;
  const emailB = `clientb-${uid()}@example.com`;
  const regA = await jsonRequest(base, 'POST', '/api/auth/register', { email: emailA, name: 'Клиент А', password: 'Demo2026!' });
  const regB = await jsonRequest(base, 'POST', '/api/auth/register', { email: emailB, name: 'Клиент Б', password: 'Demo2026!' });
  check('Регистрация двух клиентов', regA.status === 201 && regB.status === 201);

  const tokenA = regA.json.token;
  const tokenB = regB.json.token;

  const meA = await jsonRequest(base, 'GET', '/api/auth/me', undefined, tokenA);
  check('GET /api/auth/me возвращает профиль', meA.status === 200 && meA.json.user.email === emailA);
  check('Роль нового пользователя — client', meA.json.user.roles.includes('client') && !meA.json.user.roles.includes('admin'));

  /* ----- ищем рабочий день и свободный слот ----- */
  const tz = salon.json.timezone;
  let slot = null;
  let bookingDate = null;

  for (let offset = 1; offset <= 14 && !slot; offset += 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offset);
    const date = dayName(d.toISOString());
    const slotsRes = await jsonRequest(base, 'GET', `/api/masters/${master.id}/slots?date=${date}&serviceIds=${firstService.id}`, undefined, tokenA);
    const maybe = slotsRes.json?.slots ?? [];
    if (maybe.length > 0) {
      slot = maybe[0];
      bookingDate = date;
    }
  }
  check('Для мастера найдены свободные окна', slot !== null, slot ? `${bookingDate} ${slot.time}` : '');

  /* ----- удержание и запись ----- */
  const holdA = await jsonRequest(base, 'POST', '/api/holds', { masterId: master.id, startsAt: slot.startsAt, endsAt: slot.endsAt }, tokenA);
  check('Клиент А удерживает слот (hold)', holdA.status === 201 && holdA.json.held === true);

  const bookA = await jsonRequest(base, 'POST', '/api/appointments', { masterId: master.id, serviceIds: [firstService.id], startsAt: slot.startsAt }, tokenA);
  check('Клиент А подтверждает запись', bookA.status === 201 && bookA.json.appointment?.id > 0);
  const appointmentId = bookA.json.appointment.id;

  /* ----- конфликт: клиент Б на тот же слот ----- */
  const bookB = await jsonRequest(base, 'POST', '/api/appointments', { masterId: master.id, serviceIds: [firstService.id], startsAt: slot.startsAt }, tokenB);
  check('Клиент Б получает 409 на занятый слот', bookB.status === 409, bookB.json?.error?.message ?? '');

  /* ----- чужая запись: доступ Б к записи А ----- */
  const foreign = await jsonRequest(base, 'GET', `/api/appointments/${appointmentId}`, undefined, tokenB);
  check('Чужой клиент видит 403 на чужую запись', foreign.status === 403);

  /* ----- после отмены слот снова свободен ----- */
  const cancelA = await jsonRequest(base, 'POST', `/api/appointments/${appointmentId}/cancel`, {}, tokenA);
  check('Клиент А отменяет запись', cancelA.status === 200 && cancelA.json.appointment.status === 'cancelled_by_client');

  const slotsAfter = await jsonRequest(base, 'GET', `/api/masters/${master.id}/slots?date=${bookingDate}&serviceIds=${firstService.id}`, undefined, tokenA);
  const freed = (slotsAfter.json?.slots ?? []).some((s) => s.startsAt === slot.startsAt);
  check('Отменённый слот снова свободен', freed);

  /* ----- итог ----- */
  serverChild.kill('SIGTERM');
  await serverExit;

  if (existsSync(dbFile)) rmSync(dbFile);

  const failed = results.filter((r) => !r.ok);
  console.log(`\nИтог: успешно ${results.length - failed.length}, ошибок ${failed.length}.`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('Скрипт упал:', error);
  process.exit(1);
});