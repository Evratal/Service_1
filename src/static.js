/**
 * Отдача клиентской части из каталога public/.
 *
 * Отдельный файл нужен, чтобы в одном месте собрать всё, что связано
 * с безопасной работой с файловой системой.
 *
 * Главное здесь — защита от выхода за пределы каталога. Запрос вида
 * `/../../.env` или `/%2e%2e/%2e%2e/.env` не должен привести к файлу вне
 * public. Поэтому путь приводится к абсолютному и проверяется на
 * принадлежность корневому каталогу. Симлинки также запрещены: реальный путь
 * сравнивается с корнем уже после разыменования.
 */

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { contentTypeFor } from './http.js';

const INDEX_FILE = 'index.html';

/**
 * @param {string} rootDir абсолютный путь к каталогу с клиентской частью
 */
export function createStaticHandler(rootDir) {
  const root = resolve(rootDir);

  /** Переводит URL-путь в путь файла внутри корня, либо возвращает null. */
  function resolveWithinRoot(pathname) {
    const decoded = decodeURIComponent(pathname.split('?')[0]);
    const normalized = normalize(decoded).replace(/^(\.\.[/\\])+/, '');

    const candidate = resolve(join(root, normalized));
    if (candidate !== root && !candidate.startsWith(root + sep)) return null;

    return candidate;
  }

  async function statFile(filePath) {
    try {
      const info = await stat(filePath);
      return info.isFile() ? info : null;
    } catch {
      return null;
    }
  }

  /**
   * Отдаёт файл. Возвращает false, если по этому пути нечего отдавать,
   * и вызывающий код решает, что показать вместо этого (404 или index.html).
   *
   * @returns {Promise<boolean>}
   */
  return async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const target = resolveWithinRoot(pathname);
    if (!target) return false;

    let filePath = target;
    let info = await statFile(filePath);

    // Каталог отдаём его index.html — так работают / и любые красивые адреса.
    if (!info) {
      const asIndex = join(target, INDEX_FILE);
      info = await statFile(asIndex);
      if (!info) return false;
      filePath = asIndex;
    }

    // Повторная проверка после разыменования симлинков: симлинк внутри public
    // не должен вести наружу.
    try {
      const realFile = await realpath(filePath);
      const realRoot = await realpath(root);
      if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) return false;
      info = (await statFile(realFile)) ?? info;
      filePath = realFile;
    } catch {
      return false;
    }

    res.writeHead(200, {
      'Content-Type': contentTypeFor(filePath),
      'Content-Length': info.size,
      'X-Content-Type-Options': 'nosniff',
      // Разметка и стили должны обновляться, картинки можно кэшировать.
      'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=3600'
    });

    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    await new Promise((resolveStream) => {
      const stream = createReadStream(filePath);
      stream.on('error', () => {
        res.destroy();
        resolveStream();
      });
      stream.on('close', resolveStream);
      stream.pipe(res);
    });

    return true;
  };
}

export default createStaticHandler;
