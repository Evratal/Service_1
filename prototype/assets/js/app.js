/* ==========================================================================
   TOP BRO — логика кликабельного прототипа
   Три экрана связаны переходами: лендинг → форма записи → подтверждение.
   Данные зафиксированы как эталонный сценарий и не меняются между экранами.
   ========================================================================== */

/* --- Эталонные данные проекта --- */

const SERVICES = [
  { id: 's1', name: 'Мужская стрижка',      price: 2500, duration: 60 },
  { id: 's2', name: 'Стрижка и борода',    price: 3800, duration: 90 },
  { id: 's3', name: 'Бритьё бороды',       price: 1800, duration: 45 },
  { id: 's4', name: 'Камуфляж седины',     price: 2200, duration: 60 },
  { id: 's5', name: 'Детская стрижка',     price: 1800, duration: 45 },
  { id: 's6', name: 'Уход за кожей головы', price: 2400, duration: 60 }
];

const MASTERS = [
  { id: 'm1', name: 'Артём Волков', role: 'Барбер · стаж 8 лет',      services: ['s1', 's2', 's3', 's5'] },
  { id: 'm2', name: 'Даниил Орлов', role: 'Мастер-барбер · стаж 5 лет', services: ['s1', 's2', 's3', 's4'] },
  { id: 'm3', name: 'Илья Соколов', role: 'Топ-стилист · стаж 11 лет', services: ['s1', 's4', 's6'] }
];

const ANY_MASTER = { id: 'any', name: 'Любой свободный мастер', role: 'Подберём мастера автоматически', services: [] };

/* Рабочие часы студии */
const OPEN_HOUR = 10;
const CLOSE_HOUR = 21;

/* Дни без свободных окон (демонстрация состояния «нет свободного времени») */
const CLOSED_DAY_INDEX = 4;

/* Занятые слоты: ключ — день недели (0–6), значения — часы */
const BUSY = {
  0: [10, 14, 15, 16],
  1: [11, 12, 17],
  2: [10, 11, 12, 13, 18, 19],
  3: [14, 15, 19, 20],
  4: [],
  5: [10, 16, 17, 18],
  6: [12, 13, 14, 20, 21]
};

const RESERVE_SECONDS = 5 * 60;

/* --- Состояние прототипа --- */

const state = {
  services: new Set(),
  master: null,
  date: null,
  time: null,
  timer: null,
  secondsLeft: RESERVE_SECONDS
};

/* --- Вспомогательные функции --- */

const NBSP = '\u00A0';
const MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const WEEKDAYS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

const money = (n) => n.toLocaleString('ru-RU') + NBSP + '₽';

function plural(minutes) {
  const last = minutes % 10;
  const tens = minutes % 100;
  if (tens >= 11 && tens <= 14) return 'минут';
  if (last === 1) return 'минута';
  if (last >= 2 && last <= 4) return 'минуты';
  return 'минут';
}

function selectedServices() {
  return SERVICES.filter((s) => state.services.has(s.id));
}

function totalPrice() {
  return selectedServices().reduce((sum, s) => sum + s.price, 0);
}

function totalDuration() {
  return selectedServices().reduce((sum, s) => sum + s.duration, 0);
}

function currentMaster() {
  const master = MASTERS.find((m) => m.id === state.master);
  if (master) return master;
  if (state.master === ANY_MASTER.id) return ANY_MASTER;
  return null;
}

/* Формирует список дней: сегодня + следующие 6 */
function buildDates() {
  const days = [];
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    days.push({
      iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      date: d,
      index: i,
      isClosed: i === CLOSED_DAY_INDEX
    });
  }
  return days;
}

const DATES = buildDates();

function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/* --- Переключение экранов --- */

const SCREENS = {
  landing: document.getElementById('screen-landing'),
  booking: document.getElementById('screen-booking'),
  confirmation: document.getElementById('screen-confirmation')
};

function showScreen(name) {
  Object.entries(SCREENS).forEach(([key, el]) => {
    el.classList.toggle('is-active', key === name);
  });
  window.scrollTo(0, 0);
  updateStepper(name);
}

function updateStepper(screen) {
  const step1 = document.getElementById('step-1');
  const step2 = document.getElementById('step-2');
  const step3 = document.getElementById('step-3');
  [step1, step2, step3].forEach((el) => el.classList.remove('is-done', 'is-active'));

  if (screen === 'booking') {
    step1.classList.add('is-done');
    step2.classList.add('is-active');
  } else if (screen === 'confirmation') {
    step1.classList.add('is-done');
    step2.classList.add('is-done');
    step3.classList.add('is-active');
  }
}

/* --- Отрисовка: услуги --- */

function renderServices() {
  const box = document.getElementById('service-options');
  box.innerHTML = '';

  SERVICES.forEach((service) => {
    const label = document.createElement('label');
    label.className = 'option';
    label.dataset.service = service.id;
    if (state.services.has(service.id)) label.classList.add('is-selected');
    label.innerHTML = `
      <input type="checkbox" name="service" value="${service.id}" ${state.services.has(service.id) ? 'checked' : ''}>
      <span class="option__mark">✓</span>
      <span class="option__body">
        <span class="option__name">${service.name}</span>
        <span class="option__meta">${service.duration} ${plural(service.duration)}</span>
      </span>
      <span class="option__price">${money(service.price)}</span>
    `;

    label.querySelector('input').addEventListener('change', (event) => {
      if (event.target.checked) {
        state.services.add(service.id);
      } else {
        state.services.delete(service.id);
      }
      if (!selectedServices().length) {
        state.master = null;
      } else if (state.master && !availableMasters().some((m) => m.id === state.master)) {
        state.master = null;
      }
      renderServices();
      renderMasters();
      renderSlots();
      renderSummary();
    });

    box.appendChild(label);
  });
}

/* --- Отрисовка: мастера --- */

function availableMasters() {
  const ids = [...state.services];
  if (!ids.length) return [...MASTERS];
  return MASTERS.filter((m) => ids.every((id) => m.services.includes(id)));
}

function renderMasters() {
  const box = document.getElementById('master-options');
  box.innerHTML = '';

  const masters = availableMasters();

  if (state.services.size && !masters.length) {
    box.innerHTML = '<p class="muted small">Выбранные услуги не выполняет ни один мастер. Снимите лишние услуги, чтобы продолжить.</p>';
    return;
  }

  if (!state.services.size) {
    const hint = document.createElement('p');
    hint.className = 'muted tiny';
    hint.style.gridColumn = '1 / -1';
    hint.textContent = 'Сначала выберите услугу — список мастеров обновится.';
    box.appendChild(hint);
  }

  masters.forEach((master) => {
    const label = document.createElement('label');
    label.className = 'option option--radio';
    if (state.master === master.id) label.classList.add('is-selected');
    label.innerHTML = `
      <input type="radio" name="master" value="${master.id}" ${state.master === master.id ? 'checked' : ''}>
      <span class="option__mark"></span>
      <span class="option__body">
        <span class="option__name">${master.name}</span>
        <span class="option__meta">${master.role}</span>
      </span>
    `;

    label.querySelector('input').addEventListener('change', () => {
      state.master = master.id;
      state.date = null;
      state.time = null;
      stopTimer();
      renderMasters();
      renderDates();
      renderSlots();
      renderSummary();
    });

    box.appendChild(label);
  });

  if (state.services.size) {
    const label = document.createElement('label');
    label.className = 'option option--radio';
    if (state.master === ANY_MASTER.id) label.classList.add('is-selected');
    label.innerHTML = `
      <input type="radio" name="master" value="${ANY_MASTER.id}" ${state.master === ANY_MASTER.id ? 'checked' : ''}>
      <span class="option__mark"></span>
      <span class="option__body">
        <span class="option__name">${ANY_MASTER.name}</span>
        <span class="option__meta">${ANY_MASTER.role}</span>
      </span>
    `;

    label.querySelector('input').addEventListener('change', () => {
      state.master = ANY_MASTER.id;
      state.date = null;
      state.time = null;
      stopTimer();
      renderMasters();
      renderDates();
      renderSlots();
      renderSummary();
    });

    box.appendChild(label);
  }
}

/* --- Отрисовка: даты --- */

function renderDates() {
  const strip = document.getElementById('date-strip');
  strip.innerHTML = '';

  if (!state.master) {
    strip.innerHTML = '<p class="muted tiny">Сначала выберите мастера.</p>';
    return;
  }

  DATES.forEach((day) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'date';
    if (day.isClosed) button.classList.add('is-unavailable');
    if (state.date === day.iso) button.classList.add('is-selected');

    const weekday = day.index === 0 ? 'Сегодня' : day.index === 1 ? 'Завтра' : WEEKDAYS[day.date.getDay()];
    const label = day.isClosed ? 'Нет мест' : weekday;

    button.innerHTML = `
      <div class="date__day">${label}</div>
      <div class="date__num">${day.date.getDate()}</div>
      <div class="date__month">${MONTHS[day.date.getMonth()]}</div>
    `;

    if (!day.isClosed) {
      button.addEventListener('click', () => {
        state.date = day.iso;
        state.time = null;
        stopTimer();
        renderDates();
        renderSlots();
        renderSummary();
      });
    }

    strip.appendChild(button);
  });
}

/* --- Отрисовка: слоты времени --- */

function renderSlots() {
  const grid = document.getElementById('slot-grid');
  grid.innerHTML = '';

  if (!state.date) {
    grid.innerHTML = '<p class="muted tiny">Сначала выберите дату.</p>';
    return;
  }

  const day = DATES.find((d) => d.iso === state.date);

  if (!day || day.isClosed) {
    grid.innerHTML = '<p class="muted tiny">На эту дату свободных окон нет. Выберите другой день.</p>';
    return;
  }

  const busy = BUSY[day.date.getDay()] || [];

  for (let hour = OPEN_HOUR; hour <= CLOSE_HOUR; hour++) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot';
    button.textContent = `${String(hour).padStart(2, '0')}:00`;

    if (busy.includes(hour)) {
      button.disabled = true;
      button.title = 'Время занято';
    }

    if (state.time === hour && !button.disabled) {
      button.classList.add('is-selected');
    }

    button.addEventListener('click', () => {
      state.time = hour;
      startTimer();
      renderSlots();
      renderSummary();
    });

    grid.appendChild(button);
  }
}

/* --- Отрисовка: итоговая панель --- */

function renderSummary() {
  const list = document.getElementById('summary-list');
  const services = selectedServices();
  const master = currentMaster();
  const ready = services.length && master && state.date && state.time !== null;

  if (!services.length) {
    list.innerHTML = '<p class="summary__empty">Выберите услугу, мастера и время — итог появится здесь.</p>';
  } else {
    const rows = services.map((s) => `
      <div class="summary__row">
        <span>${s.name} · ${s.duration} ${plural(s.duration)}</span>
        <strong>${money(s.price)}</strong>
      </div>
    `).join('');

    const dateRow = state.date
      ? `<div class="summary__row"><span>Дата</span><strong>${longDate(state.date)}</strong></div>`
      : '<div class="summary__row"><span>Дата</span><strong class="muted">не выбрана</strong></div>';

    const timeRow = state.time !== null
      ? `<div class="summary__row"><span>Время</span><strong>${String(state.time).padStart(2, '0')}:00</strong></div>`
      : '<div class="summary__row"><span>Время</span><strong class="muted">не выбрано</strong></div>';

    list.innerHTML = `
      ${rows}
      <div class="summary__row"><span>Мастер</span><strong>${master ? master.name : 'не выбран'}</strong></div>
      ${dateRow}
      ${timeRow}
      <div class="summary__row"><span>Длительность</span><strong>${totalDuration()} ${plural(totalDuration())}</strong></div>
    `;
  }

  document.getElementById('summary-price').textContent = money(totalPrice());
  document.getElementById('tz-duration').textContent = totalDuration();
  document.getElementById('confirm-btn').disabled = !ready;
}

/* --- Таймер резерва слота --- */

function startTimer() {
  stopTimer();
  state.secondsLeft = RESERVE_SECONDS;
  document.getElementById('timer-error').hidden = true;
  state.timer = setInterval(() => {
    state.secondsLeft -= 1;
    const value = document.getElementById('timer-value');
    const min = String(Math.floor(state.secondsLeft / 60)).padStart(2, '0');
    const sec = String(state.secondsLeft % 60).padStart(2, '0');
    value.textContent = `${min}:${sec}`;

    if (state.secondsLeft <= 0) {
      stopTimer();
      state.date = null;
      state.time = null;
      document.getElementById('summary-timer').hidden = true;
      document.getElementById('timer-error').hidden = false;
      renderDates();
      renderSlots();
      renderSummary();
    }
  }, 1000);
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  document.getElementById('summary-timer').hidden = true;
}

/* --- Экран подтверждения --- */

function openConfirmation() {
  const master = currentMaster();
  const services = selectedServices();
  const names = services.map((s) => s.name).join(', ');

  document.getElementById('confirm-id').textContent =
    'TB-' + String(Math.floor(1000 + Math.random() * 9000));
  document.getElementById('confirm-service').textContent = names;
  document.getElementById('confirm-master').textContent = master.name;
  document.getElementById('confirm-date').textContent = longDate(state.date);
  document.getElementById('confirm-time').textContent = String(state.time).padStart(2, '0') + ':00';
  document.getElementById('confirm-duration').textContent = totalDuration() + ' ' + plural(totalDuration());
  document.getElementById('confirm-price').textContent = money(totalPrice());

  showScreen('confirmation');
}

/* --- Навигация --- */

document.addEventListener('click', (event) => {
  const trigger = event.target.closest('[data-go]');
  if (trigger) {
    showScreen(trigger.dataset.go);
    return;
  }

  const navLink = event.target.closest('[data-nav]');
  if (navLink) {
    event.preventDefault();
    showScreen('landing');
  }

  if (event.target.closest('#confirm-btn')) {
    openConfirmation();
  }

  if (event.target.closest('#step-1')) {
    document.getElementById('block-service').scrollIntoView({ behavior: 'smooth' });
  }
  if (event.target.closest('#step-2')) {
    document.getElementById('block-time').scrollIntoView({ behavior: 'smooth' });
  }
});

/* --- Запуск --- */

/* Демо-режим для скриншотов: index.html?demo=booking, ?demo=confirmation */
function presetDemo() {
  state.services = new Set(['s1', 's3']);
  state.master = 'm1';

  const day = DATES[0];
  state.date = day.iso;

  const busy = BUSY[day.date.getDay()] || [];
  const hour = [OPEN_HOUR, CLOSE_HOUR].find((h) => !busy.includes(h));
  state.time = hour;

  renderServices();
  renderMasters();
  renderDates();
  renderSlots();
  renderSummary();
}

renderServices();
renderMasters();
renderDates();
renderSlots();
renderSummary();

const demo = new URLSearchParams(location.search).get('demo');
if (demo === 'booking' || demo === 'confirmation') {
  presetDemo();
  showScreen('booking');
  if (demo === 'confirmation') openConfirmation();
}
