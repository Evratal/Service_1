/* ==========================================================================
   TOP BRO — клиентская часть, работает с бэкендом по API.
   Экраны: лендинг → форма записи → подтверждение, плюс личный кабинет.

   Скрипт считается внешним файлом (без инлайна), потому что политика
   Content-Security-Policy запрещает инлайновый код: даже при атаке через XSS
   браузер не выполнит чужой скрипт.
   ========================================================================== */

'use strict';

const $$ = (html) => {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content;
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);

const money = (n) => (Number(n) ?? 0).toLocaleString('ru-RU') + ' ₽';

const storageTokenKey = 'topbro-token';

const state = {
  token: localStorage.getItem(storageTokenKey) ?? null,
  user: null,
  salon: null,
  services: [],
  masters: [],
  booking: {
    serviceIds: [],
    masterId: null,
    date: null,
    slot: null,
    hold: null
  }
};

/* ---------------------------------------------------------------- API */

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (response.status === 401 && state.token && path !== '/api/auth/login') {
    logout(true);
    showToast('Сессия истекла, войдите заново.');
    location.hash = 'login';
  }

  return { status: response.status, json };
}

const get = (path) => api('GET', path);

function logout(silent = false) {
  state.token = null;
  state.user = null;
  localStorage.removeItem(storageTokenKey);
  if (!silent) api('POST', '/api/auth/logout');
}

/* ---------------------------------------------------------------- разметка

   Внутренние часы сайта — слоты и время на экране — переводятся из UTC
   в часовой пояс студии из /api/salon. */

const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function inZone(iso, timezone, pattern = 'time') {
  const dtf = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

  const parts = dtf.formatToParts(new Date(iso)).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  if (pattern === 'date') return `${parts.day} ${parts.month} ${parts.year}`;
  if (pattern === 'time') return `${parts.hour}:${parts.minute}`;
  if (pattern === 'weekday') return parts.weekday.replace('.', '');
  return `${parts.weekday.replace('.', '')}, ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

/* ---------------------------------------------------------------- тосты */

let toastTimer = null;
function showToast(message, kind = 'error') {
  const host = document.getElementById('toast');
  if (!host) return;
  host.className = `toast toast--${kind}`;
  host.textContent = message;
  host.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    host.hidden = true;
  }, 6000);
}

/* ---------------------------------------------------------------- шапка */

function headerHtml() {
  const user = state.user;
  return `
    <header class="header">
      <div class="header__inner">
        <a class="brand link" href="#/">TOP&nbsp;BRO</a>
        <nav class="nav">
          <a class="link" href="#/">Главная</a>
          <a class="link" href="#/booking">Запись</a>
          <a class="link" href="#/mine">Мои записи</a>
        </nav>
        <div class="header__auth">
          ${
            user
              ? `<span class="badge badge--accent">${esc(user.name)}</span>
                 <button class="btn btn--ghost btn--sm" data-action="logout">Выйти</button>`
              : `<a class="btn btn--primary btn--sm" href="#/login">Войти</a>`
          }
        </div>
      </div>
    </header>
    <div id="toast" class="toast" hidden></div>`;
}

/* ---------------------------------------------------------------- лендинг */

function landingHtml() {
  const s = state.salon ?? {};
  return `
    <main class="page section">
      <section class="block">
        <p class="eyebrow">Барбершоп · Москва</p>
        <h1 class="hero__title">Запись к мастеру <em>за 30 секунд</em></h1>
        <p class="muted">Выберите услугу, мастера и удобное время. Без звонков и переписки.</p>
        <div class="hero__facts">
          <div class="hero__fact"><strong id="hsalon-hours">${esc(s.workStart) ?? '10:00'}–${esc(s.workEnd) ?? '22:00'}</strong><span>ежедневно</span></div>
          <div class="hero__fact"><strong id="hsalon-masters">${state.masters.length}</strong><span>мастера в сети</span></div>
          <div class="hero__fact"><strong>${esc(s.phone)}</strong><span>и телефон</span></div>
        </div>
        <a class="btn btn--primary btn--lg" href="#/booking">Записаться</a>
      </section>

      <section class="section section--soft">
        <h2 class="section-title">Услуги</h2>
        <div class="grid">
          ${state.services
            .map(
              (service) => `
                <div class="service-card">
                  <span class="service-card__name">${esc(service.name)}</span>
                  <span class="badge badge--success">${money(service.priceRub)}</span>
                  <p class="muted small">${esc(service.description ?? '')}</p>
                  <div class="service-card__meta"><span>${service.durationMin} мин</span></div>
                </div>`
            )
            .join('')}
        </div>
      </section>

      <section class="section">
        <h2 class="section-title">Наши мастера</h2>
        <div class="grid">
          ${state.masters
            .map(
              (master) => `
                <div class="master-card">
                  <h3 class="master-card__name">${esc(master.name)}</h3>
                  <div class="master-card__role">${esc(master.specialization)}</div>
                  <p class="muted small">${esc(master.bio ?? '')}</p>
                  <a class="btn btn--primary btn--sm btn--block" href="#/booking&master=${master.id}">Выбрать</a>
                </div>`
            )
            .join('')}
        </div>
      </section>

      <section class="block section--soft">
        <h2 class="section-title">Как это работает</h2>
        <div class="grid grid--3 steps">
          <div class="step-card"><span class="step-card__num">01</span><div class="step-card__title">Выберите</div><div class="step-card__text">Услуги, мастера и удобное время — за пару кликов.</div></div>
          <div class="step-card"><span class="step-card__num">02</span><div class="step-card__title">Подтвердите</div><div class="step-card__text">Слот сразу закрепляется за вами и появляется в «Мои записи».</div></div>
          <div class="step-card"><span class="step-card__num">03</span><div class="step-card__title">Приходите</div><div class="step-card__text">Мастер видит бронь в своём графике — лишние переговоры не нужны.</div></div>
        </div>
        <div class="cta"><a class="btn btn--primary btn--lg" href="#/booking">Записаться</a></div>
      </section>

      <section class="block contacts-block">
        <h2 class="section-title">Контакты</h2>
        <div class="contacts__grid">
          <div class="contact-row"><span class="contact-row__label">Адрес</span><strong>${esc(s.address)}</strong></div>
          <div class="contact-row"><span class="contact-row__label">Часы работы</span><strong>Ежедневно ${esc(s.workStart)}–${esc(s.workEnd)}</strong></div>
          <div class="contact-row"><span class="contact-row__label">Телефон</span><strong>${esc(s.phone)}</strong></div>
        </div>
        <a class="btn btn--primary btn--sm" style="padding: 9px 18px; font-size: 13px;" href="tel:+${(s.phone || '').replace(/[^\d]/g, '')}">Позвонить</a>
      </section>
    </main>
    <footer class="footer">
      <div class="footer__inner">
        <strong class="brand">TOP&nbsp;BRO</strong>
        <span>Барбершоп в Москве · онлайн-запись за 30 секунд</span>
      </div>
    </footer>`;
}

/* ---------------------------------------------------------------- форма записи */

function nextDays(count) {
  const days = [];
  const today = new Date();
  for (let index = 1; index <= count; index += 1) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + index);
    days.push(d);
  }
  return days;
}

function bookingDayLabel(date, timezone) {
  const fmt = new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  });
  const parts = fmt.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.weekday}, ${parts.day} ${parts.month}`;
}

function bookingHtml() {
  const b = state.booking;
  const days = nextDays(10);

  return `
    <main class="page section">
      <h1 class="block__title">Выберите мастера и время</h1>
      <p class="block__hint muted small">Свободные окна рассчитываются из графика мастера и уже созданных записей.</p>

      <div class="block section--soft">
        <h2 class="block__title">1. Услуги</h2>
        <div class="option-grid">
          ${state.services
            .map(
              (service) => `
                <label class="option option--radio">
                  <input type="checkbox" value="${service.id}" data-role="service" ${
                    b.serviceIds.includes(service.id) ? 'checked' : ''
                  } />
                  <span class="option__text">${esc(service.name)} · <strong>${money(service.priceRub)}</strong></span>
                  <span class="option__hint">${service.durationMin} мин</span>
                </label>`
            )
            .join('')}
        </div>
      </div>

      <div class="block">
        <h2 class="block__title">2. Мастер</h2>
        <div id="masters-box" class="option-grid">${mastersOptionsHtml()}</div>
        <p id="masters-hint" class="muted tiny"></p>
      </div>

      <div class="block section--soft">
        <h2 class="block__title">3. Дата и время</h2>
        <div class="date-row">
          ${days
            .map(
              (day) => `
                <button class="date-chip ${b.date === day.toISOString().slice(0, 10) ? 'is-active' : ''}" data-role="day" data-date="${day.toISOString().slice(0, 10)}">
                  ${bookingDayLabel(day, state.salon.timezone).split(',')[0]}
                  <strong>${day.getDate()} ${MONTHS[day.getMonth()]}</strong>
                </button>`
            )
            .join('')}
        </div>
        <div id="slots-box">
          <p class="muted small">Сначала выберите услугу, мастера и дату.</p>
        </div>
        <div id="hold-timer" hidden class="tiny success"></div>
      </div>

      <div class="block">
        <h2 class="block__title">Итог</h2>
        <div id="summary" class="summary">Выберите услугу, мастера и время — итог появится здесь.</div>
        <label class="option">
          <span class="option__text muted">Комментарий к записи (необязательно)</span>
          <textarea id="notes" class="notes" rows="2" maxlength="500" placeholder="Например: подстригите виски покороче"></textarea>
        </label>
        <button id="confirm-btn" class="btn btn--primary btn--lg btn--block" disabled data-role="confirm">Подтвердить запись</button>
      </div>
    </main>`;
}

function mastersOptionsHtml() {
  const b = state.booking;
  const filtered = b.serviceIds.length
    ? state.masters.filter((master) => b.serviceIds.every((id) => master.serviceIds.includes(id)))
    : state.masters;

  if (filtered.length === 0) {
    return '<p class="muted small">Выбранные услуги не выполняет ни один мастер. Снимите лишние услуги.</p>';
  }

  return filtered
    .map(
      (master) => `
        <label class="option option--radio">
          <input type="radio" name="master" value="${master.id}" data-role="master" ${
            b.masterId === master.id ? 'checked' : ''
          } />
          <span class="option__text"><strong>${esc(master.name)}</strong></span>
          <span class="option__hint">${esc(master.specialization)}</span>
        </label>`
    )
    .join('');
}

async function loadSlots() {
  const b = state.booking;
  const box = document.getElementById('slots-box');
  const summary = document.getElementById('summary');

  if (!b.masterId) return;
  if (!b.date) {
    box.innerHTML = '<p class="muted small">Выберите дату.</p>';
    return;
  }

  if (b.hold) {
    api('DELETE', '/api/holds', {
      masterId: b.masterId,
      startsAt: b.hold.startsAt
    });
    b.hold = null;
  }

  const params = new URLSearchParams({ date: b.date });
  if (b.serviceIds.length) params.set('serviceIds', b.serviceIds.join(','));

  box.innerHTML = '<p class="muted small">Считаю свободное время…</p>';
  const response = await get(`/api/masters/${b.masterId}/slots?${params}`);

  const slots = response.json?.slots ?? [];

  if (slots.length === 0) {
    const reason = response.json?.reason;
    const text =
      reason === 'day_off' ? 'В этот день мастер не работает.' : 'На эту дату свободных окон нет.';
    box.innerHTML = `<p class="muted small">${text}</p>`;
    updateTotals();
    return;
  }

  box.innerHTML = `<div class="slot-grid">${slots
    .map(
      (slot) => `
        <button class="slot ${b.slot && b.slot.startsAt === slot.startsAt ? 'is-active' : ''}" data-role="slot" data-start="${slot.startsAt}" data-end="${slot.endsAt}">
          ${slot.time}
        </button>`
    )
    .join('')}</div>
    <p class="muted tiny">Доступно окон: ${slots.length}. Слот держится 5 минут после выбора.</p>`;

  updateTotals();
}

function updateTotals() {
  const b = state.booking;
  const summary = document.getElementById('summary');
  const confirmBtn = document.getElementById('confirm-btn');

  if (!summary) return;

  const selected = state.services.filter((service) => b.serviceIds.includes(service.id));
  const master = state.masters.find((m) => m.id === b.masterId);

  if (selected.length === 0 || !master) {
    summary.innerHTML = 'Выберите услугу, мастера и время — итог появится здесь.';
    confirmBtn.disabled = true;
    return;
  }

  const price = selected.reduce((sum, service) => sum + service.priceRub, 0);
  const duration = selected.reduce((sum, service) => sum + service.durationMin, 0);

  let lines = `
    <div class="summary__row"><span>Услуга</span><strong>${selected.map((s) => esc(s.name)).join(', ')}</strong></div>
    <div class="summary__row"><span>Длительность</span><strong>${duration} мин</strong></div>
    <div class="summary__row"><span>Мастер</span><strong>${esc(master.name)}</strong></div>`;

  if (b.slot) {
    lines += `<div class="summary__row"><span>Время</span><strong>${inZone(b.slot.startsAt, state.salon.timezone, 'full')}</strong></div>`;
  } else {
    lines += `<div class="summary__row"><span>Время</span><strong class="muted">выберите свободное окно</strong></div>`;
  }

  lines += `<div class="summary__row szone"><span>Итог</span><strong>${money(price)}</strong></div>`;
  summary.innerHTML = lines;
  confirmBtn.disabled = !b.slot || !b.masterId || b.serviceIds.length === 0;
}

async function pickSlot(button) {
  const b = state.booking;
  const holds = await api('POST', '/api/holds', {
    masterId: b.masterId,
    startsAt: button.dataset.start,
    endsAt: button.dataset.end
  });

  if (holds.status !== 201) {
    showToast(holds.json?.error?.message ?? 'Время только что заняли. Выберите другое.');
    loadSlots();
    return;
  }

  b.hold = { startsAt: button.dataset.start, endsAt: button.dataset.end, expiresAt: holds.json.expiresAt };
  b.slot = { startsAt: button.dataset.start, endsAt: button.dataset.end };

  document.querySelectorAll('[data-role="slot"]').forEach((el) => el.classList.remove('is-active'));
  button.classList.add('is-active');
  updateTotals();
  startHoldTimer();
}

function startHoldTimer() {
  const b = state.booking;
  const timer = document.getElementById('hold-timer');
  if (!timer || !b.hold || !b.hold.expiresAt) return;

  const tick = () => {
    if (!b.hold) return;
    const left = Math.max(0, Math.ceil((new Date(b.hold.expiresAt).getTime() - Date.now()) / 1000));
    timer.textContent = `Слот закреплён за вами на ${left} c. Подтвердите запись.`;
    timer.hidden = false;
    if (left <= 0) {
      b.hold = null;
      b.slot = null;
      timer.textContent = 'Время выбора истекло — выберите слот заново.';
      loadSlots();
      return;
    }
    setTimeout(tick, 1000);
  };
  tick();
}

async function confirmBooking() {
  const b = state.booking;
  if (!b.masterId || b.serviceIds.length === 0 || !b.slot) return;

  const response = await api('POST', '/api/appointments', {
    masterId: b.masterId,
    serviceIds: b.serviceIds,
    startsAt: b.slot.startsAt,
    notes: document.getElementById('notes')?.value ?? null
  });

  if (response.json?.appointment?.id) {
    api('DELETE', '/api/holds', { masterId: b.masterId, startsAt: b.slot.startsAt });
    b.hold = null;
    b.slot = null;
    renderConfirm(appointmentHtml(response.json.appointment));
  } else {
    showToast(response.json?.error?.message ?? 'Не удалось создать запись.');
    // Время уже заняли — показываем актуальный список слотов.
    loadSlots();
  }
}

function appointmentHtml(appointment) {
  const tz = state.salon?.timezone;
  const serviceNames = appointment.services.map((s) => esc(s.name)).join(', ');
  return `
    <main class="page section">
      <section class="block confirm">
        <h1 class="confirm__title">Запись подтверждена</h1>
        <p class="muted">Запись №${appointment.id} уже в базе. Отменить её можно в разделе «Мои записи».</p>
        <div class="details">
          <div class="details__row"><span>Мастер</span><strong>${esc(appointment.master?.name)}</strong></div>
          <div class="details__row"><span>Услуги</span><strong>${serviceNames}</strong></div>
          <div class="details__row"><span>Начало</span><strong>${inZone(appointment.startsAt, tz, 'full')}</strong></div>
          <div class="details__row"><span>Конец</span><strong>${inZone(appointment.endsAt, tz, 'full')}</strong></div>
          <div class="details__row details__row--accent"><span>Стоимость</span><strong>${money(appointment.totalPriceRub)}</strong></div>
        </div>
        <a class="btn btn--primary btn--lg" href="#/mine">Мои записи</a>
      </section>
    </main>`;
}

/* ---------------------------------------------------------------- мои записи */

async function renderMine() {
  const app = document.getElementById('app');
  if (!state.user) {
    app.replaceChildren($$(`<div class="shell">${headerHtml()}<main class="page section">
      <p class="muted">Чтобы видеть записи, <a class="link" href="#/login">войдите в аккаунт</a>.</p>
    </main></div>`));
    applyHeaderHandlers(app);
    return;
  }

  app.replaceChildren($$(`<div class="shell">${headerHtml()}<main class="page section"><p class="muted">Загружаю записи…</p></main></div>`));
  applyHeaderHandlers(app);

  const response = await get('/api/appointments');
  const appointments = response.json?.appointments ?? [];

  const cards = appointments
    .map((appointment) => {
      const serviceNames = appointment.services.map((s) => esc(s.name)).join(', ');
      const statusText = {
        booked: 'Подтверждена',
        completed: 'Выполнена',
        cancelled_by_client: 'Отменена клиентом',
        cancelled_by_salon: 'Отменена салоном',
        no_show: 'Не пришёл'
      }[appointment.status] ?? appointment.status;

      return `
        <div class="work-card">
          <div class="summary__row"><span>${inZone(appointment.startsAt, state.salon.timezone, 'full')}</span><strong>${esc(appointment.master?.name)}</strong></div>
          <p class="small">${serviceNames} · ${money(appointment.totalPriceRub)}</p>
          <span class="badge ${appointment.status === 'booked' ? 'badge--success' : 'badge--muted'}">${statusText}</span>
          ${
            appointment.status === 'booked'
              ? `<button class="btn btn--ghost btn--sm" data-action="cancel" data-id="${appointment.id}">Отменить</button>`
              : ''
          }
        </div>`;
    })
    .join('');

  app.replaceChildren(
    $$(`<div class="shell">${headerHtml()}<main class="page section">
      <h1 class="block__title">Мои записи</h1>
      ${appointments.length === 0 ? '<p class="muted">Записей пока нет. <a class="link" href="#/booking">Записаться</a></p>' : `<div class="work-grid">${cards}</div>`}
    </main></div>`)
  );
  applyHeaderHandlers(app);
}

/* ---------------------------------------------------------------- вход */

function loginHtml() {
  return `
    <main class="page section block">
      <h1 class="block__title">Вход</h1>
      <form id="login-form" class="auth-form">
        <label class="option">E-mail <input name="email" type="email" autocomplete="email" required /></label>
        <label class="option">Пароль <input name="password" type="password" autocomplete="current-password" minlength="8" required /></label>
        <button class="btn btn--primary" type="submit">Войти</button>
        <p class="muted tiny">Нет аккаунта? Зарегистрируйтесь тут же — достаточно e-mail, имени и пароля.</p>
      </form>
      <hr />
      <details class="block"><summary>Зарегистрироваться</summary>
        <form id="register-form" class="auth-form">
          <label class="option">Имя <input name="name" required minlength="2" /></label>
          <label class="option">E-mail <input name="email" type="email" required /></label>
          <label class="option">Пароль <input name="password" type="password" minlength="8" required /></label>
          <button class="btn btn--secondary" type="submit">Создать аккаунт</button>
        </form>
      </details>
      <p class="muted tiny">Демо-данные: anna@example.com / oleg@example.com, пароль Demo2026!</p>
    </main>`;
}

/* ---------------------------------------------------------------- маршрутизация */

async function renderLandingView() {
  const app = document.getElementById('app');
  app.replaceChildren($$(`<main class="page section"><p class="muted">Загружаю…</p></main>`));
  const [services, masters, salon] = await Promise.all([
    get('/api/services'),
    get('/api/masters'),
    get('/api/salon')
  ]);

  state.services = services.json?.services ?? [];
  state.masters = masters.json?.masters ?? [];
  state.salon = salon.json ?? null;

  app.replaceChildren(
    $$(`<div class="shell">${headerHtml()}${landingHtml()}</div>`)
  );
  applyHeaderHandlers(app);
}

async function renderBookingView() {
  if (state.services.length === 0 || state.masters.length === 0) {
    const [services, masters] = await Promise.all([get('/api/services'), get('/api/masters')]);
    state.services = services.json?.services ?? state.services;
    state.masters = masters.json?.masters ?? state.masters;
  }

  if (!state.salon) {
    const salon = await get('/api/salon');
    state.salon = salon.json;
  }

  const app = document.getElementById('app');
  app.replaceChildren($$(`<div class="shell">${headerHtml()}${bookingHtml()}</div>`));
  applyHeaderHandlers(app);

  const masterParam = location.hash.match(/master=(\d+)/);
  if (masterParam) {
    state.booking.masterId = Number(masterParam[1]);
    document.querySelectorAll('[data-role="master"]').forEach((input) => {
      input.checked = input.value === masterParam[1];
    });
  }

  // Если услуги выбраны заранее — пересчитываем мастеров и слоты.
  document.querySelectorAll('[data-role="service"]').forEach((input) => {
    input.addEventListener('change', async () => {
      state.booking.serviceIds = [...document.querySelectorAll('[data-role="service"]:checked')].map((el) => Number(el.value));
      state.booking.masterId = null;
      state.booking.slot = null;
      const box = document.getElementById('masters-box');
      box.innerHTML = mastersOptionsHtml();
      updateTotals();
      loadSlots();
    });
  });

  document.getElementById('masters-box').addEventListener('change', (event) => {
    const input = event.target.closest('[data-role="master"]');
    if (!input) return;
    state.booking.masterId = Number(input.value);
    state.booking.slot = null;
    loadSlots();
  });

  document.querySelectorAll('[data-role="day"]').forEach((day) => {
    day.addEventListener('click', () => {
      document.querySelectorAll('[data-role="day"]').forEach((el) => el.classList.remove('is-active'));
      day.classList.add('is-active');
      state.booking.date = day.dataset.date;
      state.booking.slot = null;
      if (!state.booking.masterId) {
        const box = document.getElementById('slots-box');
        if (box) box.innerHTML = '<p class="muted small">Сначала выберите мастера.</p>';
        return;
      }
      loadSlots();
    });
  });

  document.getElementById('slots-box').addEventListener('click', (event) => {
    const button = event.target.closest('[data-role="slot"]');
    if (button) pickSlot(button);
  });

  document.getElementById('confirm-btn').addEventListener('click', confirmBooking);

  if (state.booking.serviceIds.length) {
    document.querySelectorAll('[data-role="service"]').forEach((input) => {
      input.checked = state.booking.serviceIds.includes(Number(input.value));
    });
  }

  if (state.booking.masterId && state.booking.date) loadSlots();
}

function renderConfirm(markup) {
  const app = document.getElementById('app');
  app.replaceChildren($$(`<div class="shell">${headerHtml()}${markup}</div>`));
  applyHeaderHandlers(app);
}

async function renderLoginView() {
  const app = document.getElementById('app');
  app.replaceChildren($$(`<div class="shell">${headerHtml()}${loginHtml()}</div>`));
  applyHeaderHandlers(app);

  const submitForm = async (event, mode) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form).entries());

    const path = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const response = await api('POST', path, body);

    if (response.status === 200 || response.status === 201) {
      state.token = response.json.token;
      state.user = response.json.user;
      localStorage.setItem(storageTokenKey, state.token);
      showToast(`Добро пожаловать, ${state.user.name}!`, 'success');
      location.hash = '#/';
    } else {
      showToast(response.json?.error?.message ?? 'Не удалось войти.');
    }
  };

  document.getElementById('login-form').addEventListener('submit', (e) => submitForm(e, 'login'));
  document.getElementById('register-form').addEventListener('submit', (e) => submitForm(e, 'register'));
}

function applyHeaderHandlers(app) {
  const logoutButton = app.querySelector('[data-action="logout"]');
  if (logoutButton) {
    logoutButton.addEventListener('click', () => {
      logout();
      location.hash = '#/';
    });
  }

  const cancelButtons = app.querySelectorAll('[data-action="cancel"]');
  cancelButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      const id = Number(button.dataset.id);
      const response = await api('POST', `/api/appointments/${id}/cancel`, {});
      if (response.json?.appointment?.id) {
        showToast('Запись отменена.', 'success');
        renderMine();
      } else {
        showToast(response.json?.error?.message ?? 'Не удалось отменить запись.');
      }
    });
  });
}

async function route() {
  if (!state.salon && !state.user) {
    const me = state.token ? await get('/api/auth/me') : { status: 401 };
    if (me.status === 200) state.user = me.json.user;
  }

  const hash = (location.hash || '#/').replace(/^#/, '');
  if (hash.startsWith('/booking')) renderBookingView();
  else if (hash.startsWith('/mine')) renderMine();
  else if (hash.startsWith('/login')) renderLoginView();
  else renderLandingView();
}

window.addEventListener('hashchange', route);
route();

/* Экспорт для консоли во время отладки. */
window.__topbro = { state, api };