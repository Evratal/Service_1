/**
 * Проверка входных данных на сервере.
 *
 * Почему проверка обязана быть на сервере, а не только в браузере: правила
 * проверки в JavaScript клиента пользователь может обойти в консоли или
 * отправить запрос вручную. Единственное место, которому можно доверять, —
 * сервер.
 *
 * Правило одно: проверяется ВСЁ, что пришло от клиента, включая поля, которые
 * сервер определяет сам. Значение, вычисляемое сервером, нельзя принять из
 * тела запроса — иначе клиент сможет выдать себя за администратора.
 */

import { badRequest } from './errors.js';
import { isValidDateString, parseHhMm } from './time.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Проверка одной строки. */
function checkString(raw, rule) {
  if (typeof raw !== 'string') return { code: 'type', message: 'ожидалась строка' };

  // Нормируем пробелы по краям: « admin@topbro.ru » и «admin@topbro.ru»
  // должны быть одним и тем же аккаунтом.
  const value = rule.trim === false ? raw : raw.trim();

  if (rule.type === 'email') {
    const email = value.toLowerCase();
    if (!EMAIL_PATTERN.test(email)) return { code: 'email', message: 'не похоже на e-mail' };
    if (email.length > 254) return { code: 'max_length', message: 'слишком длинный e-mail' };
    return { value: email };
  }

  if (rule.type === 'password') {
    // Пароль НЕ обрезаем: пробелы в начале и конце могут быть частью пароля.
    if (value.length === 0) return { code: 'required', message: 'пароль не может быть пустым' };
    if (value.length < 8) return { code: 'min_length', message: 'минимум 8 символов' };
    if (value.length > 200) return { code: 'max_length', message: 'не более 200 символов' };
    return { value };
  }

  if (rule.pattern && !rule.pattern.test(value)) {
    return { code: 'pattern', message: 'недопустимый формат' };
  }

  if (rule.min !== undefined && value.length < rule.min) {
    return { code: 'min_length', message: `минимум ${rule.min} символов` };
  }
  if (rule.max !== undefined && value.length > rule.max) {
    return { code: 'max_length', message: `не более ${rule.max} символов` };
  }

  return { value };
}

function checkInt(raw, rule) {
  // Принимаем только настоящее число. "5" и true в Number() тоже
  // превратились бы в 5, поэтому сравниваем со строкой.
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return { code: 'type', message: 'ожидалось целое число' };
  }
  if (rule.min !== undefined && raw < rule.min) {
    return { code: 'min', message: `минимум ${rule.min}` };
  }
  if (rule.max !== undefined && raw > rule.max) {
    return { code: 'max', message: `максимум ${rule.max}` };
  }
  return { value: raw };
}

function checkIdList(raw, rule) {
  if (!Array.isArray(raw)) return { code: 'type', message: 'ожидался список' };
  if (raw.length === 0) return { code: 'empty', message: 'список не может быть пустым' };
  if (rule.maxItems !== undefined && raw.length > rule.maxItems) {
    return { code: 'max_items', message: `не более ${rule.maxItems} элементов` };
  }

  const ids = [];
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 2 ** 31 - 1) {
      return { code: 'type', message: 'список должен содержать положительные целые числа' };
    }
    if (!ids.includes(item)) ids.push(item);
  }

  return { value: ids };
}

function checkEnum(raw, rule) {
  if (typeof raw !== 'string' || !rule.values.includes(raw)) {
    return { code: 'enum', message: `допустимо: ${rule.values.join(', ')}` };
  }
  return { value: raw };
}

function checkDate(raw) {
  if (!isValidDateString(raw)) return { code: 'date', message: 'ожидался формат YYYY-MM-DD' };
  return { value: raw };
}

function checkTime(raw) {
  if (parseHhMm(raw) === null) return { code: 'time', message: 'ожидался формат ЧЧ:ММ' };
  return { value: raw };
}

function checkBoolean(raw) {
  if (typeof raw !== 'boolean') return { code: 'type', message: 'ожидалось true или false' };
  return { value: raw };
}

const CHECKERS = {
  string: checkString,
  email: checkString,
  password: checkString,
  int: checkInt,
  idList: checkIdList,
  enum: checkEnum,
  date: checkDate,
  time: checkTime,
  boolean: checkBoolean
};

/**
 * Проверяет объект по описанию правил.
 *
 * @param {unknown} payload разобранное тело запроса
 * @param {Record<string, object>} rules описание полей
 * @returns {Record<string, unknown>} объект с ТОЛЬКО проверенными полями
 * @throws {import('./errors.js').HttpError} 400 со списком проблемных полей
 *
 * @example
 *   const data = validate(req.body, {
 *     email: { type: 'email', required: true },
 *     name:  { type: 'string', required: true, max: 120 },
 *     role:  { type: 'string', required: false, default: 'client' }
 *   });
 */
export function validate(payload, rules) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw badRequest('Ожидался JSON-объект с полями.');
  }

  const errors = [];
  const result = {};

  for (const [field, rule] of Object.entries(rules)) {
    const raw = payload[field];

    // Необязательное поле, которого нет, — это не ошибка, а значение по умолчанию.
    if (raw === undefined || raw === null || raw === '') {
      if (rule.required) {
        errors.push({ field, code: 'required', message: 'обязательное поле' });
      } else if (rule.default !== undefined) {
        result[field] = rule.default;
      } else if (rule.nullable) {
        result[field] = null;
      }
      continue;
    }

    const check = CHECKERS[rule.type];
    if (!check) {
      throw new Error(`Неизвестный тип проверки: ${rule.type} (поле ${field})`);
    }

    const outcome = check(raw, rule);
    if (outcome.code) {
      errors.push({ field, code: outcome.code, message: outcome.message });
    } else {
      result[field] = outcome.value;
    }
  }

  if (errors.length > 0) {
    throw badRequest('Проверьте правильность полей.', { fields: errors });
  }

  return result;
}

/** Убирает управляющие символы из свободного текста перед сохранением. */
export function cleanText(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const withoutControl = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return withoutControl === '' ? null : withoutControl;
}
