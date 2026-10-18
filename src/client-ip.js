/**
 * Реальный адрес клиента.
 *
 * Node видит только адрес сокета (remoteAddress). Заголовок X-Forwarded-For
 * клиент может подделать сам — и если сервер ему поверит, любой сможет
 * обойти ограничение числа попыток входа или снять чужое удержание слота.
 *
 * Поэтому заголовок принимается ТОЛЬКО при TRUST_PROXY=1, и только когда
 * сервер реально стоит за нашим прокси (nginx на сервере Beget). По умолчанию
 * доверяем адресу сокета — его подделать нельзя.
 */

import { config } from './config.js';

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function realClientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim() !== '') {
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}