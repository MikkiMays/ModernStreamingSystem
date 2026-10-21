#!/usr/bin/env node
/**
 * Живая проверка: TURN LiveKit — не открытый relay (A12 docs/abuse-model.md).
 *
 * Что делает, против настоящего LiveKit:
 *   1. Allocate без учётки — должен быть отказ 401 (выделить relay без входа нельзя).
 *   2. Входит в комнату как участник (JWT из ключа API, сигналинг /rtc) и берёт учётку TURN из ответа
 *      `join` — ту же, что получает браузер.
 *   3. Allocate с учёткой — должен пройти.
 *   4. CreatePermission к адресу узла (SFU) — должен пройти: учётка рабочая, медиа до SFU доходит.
 *   5. CreatePermission к публичным адресам интернета, к loopback, к частным сетям, к метаданным облака и
 *      CGNAT — каждый должен получить отказ.
 *
 * Запуск: `node scripts/turn-relay-check.mjs --signal=ws://127.0.0.1:7880 --turn=127.0.0.1:3478 \
 *   --peer=<адрес узла> --key=<LIVEKIT_API_KEY> --secret=<LIVEKIT_API_SECRET>` (ключи можно взять из
 * `--env=.env`). Выход 0 — relay закрыт как надо; 1 — нет. `--expect-open` переворачивает ожидание для
 * публичных адресов: им харнесс доказывает, что без правил дыра была.
 *
 * Обёртка с одноразовым LiveKit в Docker — `scripts/turn-relay-check.sh` (её зовёт CI).
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { readFileSync } from 'node:fs';

const MAGIC = 0x2112a442;
const ATTR = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
};
export const METHOD = { ALLOCATE: 0x0003, REFRESH: 0x0004, CREATE_PERMISSION: 0x0008 };

/** Атрибут STUN: тип, длина, значение и выравнивание до 4 байт. */
function attribute(type, value) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value, Buffer.alloc((4 - (value.length % 4)) % 4)]);
}

/** XOR-адрес IPv4 (RFC 5389 §15.2). */
export function xorAddress(ip, port) {
  const value = Buffer.alloc(8);
  value.writeUInt8(0x01, 1);
  value.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const n = ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
  value.writeUInt32BE((n ^ MAGIC) >>> 0, 4);
  return value;
}

export function readXorAddress(value) {
  const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
  const n = (value.readUInt32BE(4) ^ MAGIC) >>> 0;
  return { ip: [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.'), port };
}

/**
 * Запрос STUN. `key` — ключ долгосрочной учётки (MD5 «имя:realm:пароль»); с ним в конец ложится
 * MESSAGE-INTEGRITY (HMAC-SHA1 по сообщению, где длина уже учитывает этот атрибут).
 */
export function request(method, attributes, key, transaction = randomBytes(12)) {
  let body = Buffer.concat(attributes.map(([type, value]) => attribute(type, value)));
  const header = (length) => {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(method, 0);
    h.writeUInt16BE(length, 2);
    h.writeUInt32BE(MAGIC, 4);
    transaction.copy(h, 8);
    return h;
  };
  if (key) {
    const mac = createHmac('sha1', key).update(Buffer.concat([header(body.length + 24), body])).digest();
    body = Buffer.concat([body, attribute(ATTR.MESSAGE_INTEGRITY, mac)]);
  }
  return Buffer.concat([header(body.length), body]);
}

/** Ответ STUN: класс (успех или ошибка), код ошибки и атрибуты. */
export function parse(message) {
  const type = message.readUInt16BE(0);
  const length = message.readUInt16BE(2);
  const attributes = new Map();
  for (let at = 20; at + 4 <= 20 + length; ) {
    const kind = message.readUInt16BE(at);
    const size = message.readUInt16BE(at + 2);
    attributes.set(kind, message.subarray(at + 4, at + 4 + size));
    at += 4 + size + ((4 - (size % 4)) % 4);
  }
  const error = attributes.get(ATTR.ERROR_CODE);
  return {
    success: (type & 0x0110) === 0x0100,
    error: error ? (error[2] & 7) * 100 + error[3] : null,
    transaction: message.subarray(8, 20),
    attributes,
  };
}

/** Один запрос — один ответ по тому же номеру транзакции. */
function exchange(socket, host, port, message) {
  return new Promise((resolve, reject) => {
    const id = message.subarray(8, 20);
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('TURN не ответил за 5 с'));
    }, 5000);
    const onMessage = (data) => {
      if (data.length < 20 || !data.subarray(8, 20).equals(id)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(parse(data));
    };
    socket.on('message', onMessage);
    socket.send(message, port, host);
  });
}

const base64url = (value) => Buffer.from(value).toString('base64url');

/** JWT участника LiveKit (HS256), ровно столько прав, сколько нужно, чтобы получить `join`. */
export function token(key, secret, room, identity) {
  const now = Math.floor(Date.now() / 1000);
  const head = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: key,
      sub: identity,
      nbf: now - 10,
      exp: now + 300,
      video: { room, roomJoin: true, canPublish: false, canSubscribe: false },
    }),
  );
  const signature = createHmac('sha256', secret).update(`${head}.${claims}`).digest('base64url');
  return `${head}.${claims}.${signature}`;
}

/** Поля сообщения protobuf (без схемы): номер, тип провода, значение. */
function fields(buffer) {
  const out = [];
  let at = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (at >= buffer.length) throw new Error('varint');
      const byte = buffer[at++];
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
    }
  };
  while (at < buffer.length) {
    const tag = Number(varint());
    const number = tag >> 3;
    const wire = tag & 7;
    if (number === 0) throw new Error('field 0');
    if (wire === 0) out.push([number, wire, varint()]);
    else if (wire === 1) (out.push([number, wire, buffer.subarray(at, at + 8)]), (at += 8));
    else if (wire === 5) (out.push([number, wire, buffer.subarray(at, at + 4)]), (at += 4));
    else if (wire === 2) {
      const size = Number(varint());
      if (at + size > buffer.length) throw new Error('length');
      out.push([number, wire, buffer.subarray(at, at + size)]);
      at += size;
    } else throw new Error(`wire ${wire}`);
  }
  return out;
}

/**
 * Учётка TURN из ответа `join`: сообщение ICEServer (`urls` = 1, `username` = 2, `credential` = 3), где
 * адрес начинается с `turn:`. Ищется обходом всего ответа — без копии схемы протокола LiveKit.
 */
export function turnCredentials(buffer, depth = 0) {
  let parsed;
  try {
    parsed = fields(buffer);
  } catch {
    return null;
  }
  const text = (n) => parsed.filter(([k, w]) => k === n && w === 2).map(([, , v]) => v.toString('utf8'));
  const urls = text(1);
  if (urls.some((url) => /^turns?:/.test(url)) && text(2).length && text(3).length)
    return { urls, username: text(2)[0], credential: text(3)[0] };
  if (depth > 6) return null;
  for (const [, wire, value] of parsed)
    if (wire === 2 && value.length > 2) {
      const found = turnCredentials(value, depth + 1);
      if (found) return found;
    }
  return null;
}

async function credentials(signal, key, secret) {
  const room = `turn-check-${randomBytes(4).toString('hex')}`;
  const url = `${signal}/rtc?access_token=${token(key, secret, room, 'turn-check')}&auto_subscribe=0&sdk=js&protocol=15`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const timer = setTimeout(() => (socket.close(), reject(new Error('сигналинг не прислал join за 15 с'))), 15000);
    socket.onmessage = (event) => {
      const found = turnCredentials(Buffer.from(event.data));
      if (!found) return;
      clearTimeout(timer);
      socket.close();
      resolve(found);
    };
    socket.onerror = () => (clearTimeout(timer), reject(new Error(`сигналинг ${signal} недоступен`)));
  });
}

/**
 * Куда relay вести нельзя: интернет, сам сервер изнутри, облачные метаданные, CGNAT, частные сети.
 * Третье поле — открыт ли адрес у LiveKit без наших правил (Go не считает CGNAT «закрытым»).
 */
export const FORBIDDEN = [
  ['8.8.8.8', 'публичный адрес', true],
  ['1.1.1.1', 'публичный адрес', true],
  ['127.0.0.1', 'loopback сервера', false],
  ['10.0.0.1', 'частная сеть', false],
  ['172.17.0.1', 'сеть Docker', false],
  ['192.168.1.1', 'частная сеть', false],
  ['169.254.169.254', 'метаданные облака', false],
  ['100.64.0.1', 'CGNAT', true],
];

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
  const env = args.env
    ? Object.fromEntries(
        readFileSync(args.env, 'utf8')
          .split('\n')
          .filter((line) => /^[A-Z_]+=/.test(line))
          .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
      )
    : {};
  const key = args.key ?? env.LIVEKIT_API_KEY;
  const secret = args.secret ?? env.LIVEKIT_API_SECRET;
  const peer = args.peer ?? env.PUBLIC_IP;
  const signal = args.signal ?? 'ws://127.0.0.1:7880';
  const [host, port] = (args.turn ?? '127.0.0.1:3478').split(':');
  const expectOpen = 'expect-open' in args;
  if (!key || !secret || !peer) throw new Error('Нужны --key, --secret и --peer (или --env=.env)');

  const socket = createSocket('udp4');
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const transport = [ATTR.REQUESTED_TRANSPORT, Buffer.from([17, 0, 0, 0])];
  try {
    const anonymous = await exchange(socket, host, Number(port), request(METHOD.ALLOCATE, [transport]));
    check('Allocate без учётки отклонён', anonymous.error === 401, `ответ ${anonymous.error ?? 'успех'}`);
    const realm = anonymous.attributes.get(ATTR.REALM);
    const nonce = anonymous.attributes.get(ATTR.NONCE);

    const creds = await credentials(signal, key, secret);
    const longTerm = createHash('md5').update(`${creds.username}:${realm}:${creds.credential}`).digest();
    const auth = (current) => [
      [ATTR.USERNAME, Buffer.from(creds.username)],
      [ATTR.REALM, realm],
      [ATTR.NONCE, current],
    ];
    const allocated = await exchange(
      socket,
      host,
      Number(port),
      request(METHOD.ALLOCATE, [transport, ...auth(nonce)], longTerm),
    );
    const relayed = allocated.attributes.get(ATTR.XOR_RELAYED_ADDRESS);
    check(
      'Allocate с учёткой участника прошёл',
      allocated.success,
      allocated.success ? `relay ${readXorAddress(relayed).ip}` : `ответ ${allocated.error}`,
    );
    if (!allocated.success) throw new Error('без выделенного relay дальше проверять нечего');

    const permit = (ip) =>
      exchange(
        socket,
        host,
        Number(port),
        request(METHOD.CREATE_PERMISSION, [[ATTR.XOR_PEER_ADDRESS, xorAddress(ip, 9)], ...auth(nonce)], longTerm),
      );
    const own = await permit(peer);
    check(`relay к SFU (${peer}) разрешён`, own.success, own.success ? '' : `ответ ${own.error}`);
    for (const [ip, what, openByDefault] of FORBIDDEN) {
      const answer = await permit(ip);
      const open = openByDefault && expectOpen;
      check(
        `relay к ${ip} (${what}) ${open ? 'открыт без правил' : 'запрещён'}`,
        open ? answer.success : !answer.success,
        answer.success ? 'разрешение выдано' : `ответ ${answer.error}`,
      );
    }
    await exchange(
      socket,
      host,
      Number(port),
      request(METHOD.REFRESH, [[ATTR.LIFETIME, Buffer.from([0, 0, 0, 0])], ...auth(nonce)], longTerm),
    ).catch(() => {});
  } finally {
    socket.close();
  }
  if (results.some((ok) => !ok)) process.exit(1);
  console.log(expectOpen ? 'Без правил relay в интернет открыт (это и есть дыра A12).' : 'TURN — не открытый relay.');
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((error) => {
    console.error(`FAIL ${error.message}`);
    process.exit(1);
  });
