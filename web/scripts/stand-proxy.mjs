#!/usr/bin/env node
// Прокси к стенду для dev-сервера (скилл verify): ядро отвечает 403 на чужой Origin, поэтому прокси
// подставляет origin/host стенда. Для снимков невыкаченных экранов (E15-B) — прихожая, настройки,
// витрины; встреча через dev-сервер живёт секунды (SFU стенда другому origin недоступен).
//
//   node scripts/stand-proxy.mjs [--port 18080] [--target https://cord.nikg.tech]
//   CORD_DEV_API=http://127.0.0.1:18080 CORD_DEV_SERVICES=http://127.0.0.1:18080 npx vite --port 5199
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const target = new URL(arg('target', 'https://cord.nikg.tech'));
const port = Number(arg('port', 18080));

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: target.host, origin: target.origin };
  if (headers.referer) headers.referer = headers.referer.replace(/^https?:\/\/[^/]+/, target.origin);
  const upstream = https.request(
    { host: target.hostname, port: 443, path: req.url, method: req.method, headers, servername: target.hostname },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
});

// WebSocket: сырой туннель с теми же подменами в рукопожатии.
server.on('upgrade', (req, socket, head) => {
  const tlsSocket = tls.connect(443, target.hostname, { servername: target.hostname }, () => {
    const headers = { ...req.headers, host: target.host, origin: target.origin };
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', ''];
    tlsSocket.write(lines.join('\r\n'));
    if (head?.length) tlsSocket.write(head);
    tlsSocket.pipe(socket);
    socket.pipe(tlsSocket);
  });
  tlsSocket.on('error', () => socket.destroy());
  socket.on('error', () => tlsSocket.destroy());
});

server.listen(port, '127.0.0.1', () => console.log(`прокси ${port} → ${target.origin}`));
