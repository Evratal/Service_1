/**
 * Ошибки приложения.
 *
 * Единый класс HttpError: код ответа, машиночитаемый код и текст для человека.
 * Всё, что не HttpError, считается внутренней ошибкой: клиент получит
 * обезличенное сообщение, а настоящая причина уйдёт в журнал сервера.
 */

export class HttpError extends Error {
  /**
   * @param {number} status код HTTP-ответа
   * @param {string} code короткий машиночитаемый код, например `slot_conflict`
   * @param {string} message понятное человеку сообщение
   * @param {object} [details] дополнительные данные, например список свободных слотов
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) =>
  new HttpError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Нужно войти в аккаунт.') =>
  new HttpError(401, 'unauthorized', message);

export const forbidden = (message = 'Недостаточно прав для этого действия.') =>
  new HttpError(403, 'forbidden', message);

export const notFound = (message = 'Не найдено.') =>
  new HttpError(404, 'not_found', message);

export const conflict = (code, message, details) =>
  new HttpError(409, code, message, details);

export const tooManyRequests = (message, details) =>
  new HttpError(429, 'too_many_requests', message, details);

export const serverError = (message = 'Внутренняя ошибка сервера.') =>
  new HttpError(500, 'server_error', message);
