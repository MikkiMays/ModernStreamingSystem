// Сервер замера: файлы с Range, общий ограничитель полосы и счёт отданных байт.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const MEDIA = process.env.MEDIA;
const DIST = new URL('./dist/', import.meta.url).pathname;
let rate = 0; // байт/с, 0 — без предела
let chunk = 0; // предел ответа на открытый диапазон, байт; 0 — без предела
let sent = 0;
let bucket = 0;
let last = Date.now();
const log = [];
const TYPES = {
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mpd': 'application/dash+xml',
  '.m4s': 'video/iso.segment',
  '.html': 'text/html',
  '.js': 'text/javascript',
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function take(n) {
  if (!rate) return;
  for (;;) {
    const now = Date.now();
    bucket = Math.min(rate * 0.25, bucket + ((now - last) / 1000) * rate);
    last = now;
    if (bucket >= n) {
      bucket -= n;
      return;
    }
    await wait(Math.max(5, ((n - bucket) / rate) * 1000));
  }
}
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/stats') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ sent, requests: log.length, log: log.slice(-400) }));
    }
    if (url.pathname === '/reset') {
      sent = 0;
      log.length = 0;
      rate = Number(url.searchParams.get('rate') || 0);
      chunk = Number(url.searchParams.get('chunk') || 0);
      bucket = 0;
      return res.end('ok');
    }
    const file = url.pathname.startsWith('/media/')
      ? path.join(MEDIA, url.pathname.slice(7))
      : path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      res.statusCode = 404;
      return res.end();
    }
    let start = 0,
      end = stat.size - 1,
      status = 200;
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      status = 206;
      if (range[1]) start = +range[1];
      if (range[2]) end = Math.min(+range[2], end);
      if (!range[1]) {
        start = stat.size - +range[2];
        end = stat.size - 1;
      }
      // Открытый диапазон (`bytes=N-`) — не дальше куска: так отвечает прокси кинозала после R172 (`chunk`).
      if (chunk && range[1] && !range[2]) end = Math.min(end, start + chunk - 1);
    }
    res.writeHead(status, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-length': end - start + 1,
      'accept-ranges': 'bytes',
      ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}),
    });
    const entry = {
      at: Date.now(),
      path: url.pathname,
      range: req.headers.range || '',
      bytes: 0,
      closed: false,
    };
    log.push(entry);
    const fd = fs.openSync(file, 'r');
    const SIZE = 16384;
    let pos = start;
    let gone = false;
    req.on('close', () => {
      gone = true;
      entry.closed = true;
    });
    try {
      while (pos <= end && !gone) {
        const chunk = Buffer.alloc(Math.min(SIZE, end - pos + 1));
        const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
        await take(n);
        if (gone) break;
        const ok = res.write(chunk.subarray(0, n));
        pos += n;
        sent += n;
        entry.bytes += n;
        if (!ok)
          await new Promise((r) => {
            const done = () => {
              res.off('drain', done);
              res.off('close', done);
              r();
            };
            res.on('drain', done);
            res.on('close', done);
          });
      }
    } finally {
      fs.closeSync(fd);
      res.end();
    }
  })
  .listen(Number(process.env.PORT || 18911), '127.0.0.1');
