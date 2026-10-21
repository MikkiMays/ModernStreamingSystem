/**
 * TURN Cord — не открытый relay (A12 docs/abuse-model.md).
 *
 * ЗАЧЕМ. Встроенный TURN LiveKit нужен ровно для одного: довести медиа участника, которому сеть не даёт
 * UDP напрямую, до SFU этой же машины. Учётку TURN получает каждый вошедший во встречу, и без правил она
 * пересылает UDP куда угодно в интернет с адреса сервера — бесплатный анонимайзер. LiveKit 1.13 сам не
 * пускает к «закрытым» адресам (loopback, link-local, multicast, частные сети, `0.0.0.0` —
 * `pkg/service/turn.go`, `permissionHandler`), но публичные адреса открыты все.
 *
 * ЧТО ДЕЛАЕМ. `turn.deny_peer_cidrs` — дополнение адреса узла (`node_ip`) до всего IPv4: 32 сети, которые
 * вместе покрывают всё, кроме самого узла, и весь IPv6. Запрет у LiveKit сильнее любого разрешения, так что
 * relay остаётся только к SFU. Если адрес узла сам «закрытый» (установка в локальной сети), он один
 * разрешается `allow_restricted_peer_cidrs` — иначе TURN не довёл бы медиа и до своего SFU.
 *
 * Правило проверки повторено здесь (`permits`) — им тест сверяет порождённый `livekit.json`, а
 * `turn-relay-check.mjs` — живой LiveKit.
 */

/** IPv4 строкой → число (или null, если это не IPv4). */
export function ipv4(text) {
  const parts = String(text).trim().split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

const dotted = (n) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');

/** Сеть `a.b.c.d/len` → [начало, длина]. */
function cidr(text) {
  const [address, length] = text.split('/');
  const start = ipv4(address);
  return start === null ? null : [start, Number(length)];
}

function contains([start, length], n) {
  const size = 2 ** (32 - length);
  return n >= start && n < start + size;
}

// Что LiveKit 1.13.6 считает «закрытым» для IPv4 (Go: IsLoopback, IsLinkLocalUnicast, IsLinkLocalMulticast,
// IsMulticast, IsPrivate, IsUnspecified).
const RESTRICTED_V4 = ['127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

export function restricted(text) {
  const n = ipv4(text);
  if (n === null) return true;
  return n === 0 || RESTRICTED_V4.some((range) => contains(cidr(range), n));
}

/** Все сети IPv4, кроме одного адреса: по одной на каждый бит, где путь расходится с адресом. */
export function complement(address) {
  const n = ipv4(address);
  if (n === null) throw new Error(`Адрес узла «${address}» — не IPv4: правила TURN не построить`);
  const out = [];
  for (let length = 1; length <= 32; length++) {
    const size = 2 ** (32 - length);
    // Последний бит префикса — наоборот. Без `^`: побитовые операции JS 32-битные со знаком.
    const prefix = Math.floor(n / size);
    const flipped = prefix % 2 === 0 ? prefix + 1 : prefix - 1;
    out.push(`${dotted(flipped * size)}/${length}`);
  }
  return out;
}

/** IPv6 строкой → BigInt (или null). Разбирает и сокращённую запись `::`. */
export function ipv6(text) {
  const value = String(text).trim();
  if (!/^[0-9a-f:]+$/i.test(value) || (value.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = value.includes('::') ? value.split('::') : [value, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === null ? left.length !== 8 : missing < 1) return null;
  const groups = [...left, ...Array(tail === null ? 0 : missing).fill('0'), ...right];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.reduce((n, g) => (n << 16n) + BigInt(parseInt(g, 16)), 0n);
}

/** Все сети IPv6, кроме одного адреса (128 сетей, полная запись групп). */
export function complement6(address) {
  const n = ipv6(address);
  if (n === null) throw new Error(`Адрес узла «${address}» — не IPv6`);
  const out = [];
  for (let length = 1; length <= 128; length++) {
    const shift = BigInt(128 - length);
    const start = ((n >> shift) ^ 1n) << shift;
    const groups = Array.from({ length: 8 }, (_, i) => ((start >> BigInt(112 - 16 * i)) & 0xffffn).toString(16));
    out.push(`${groups.join(':')}/${length}`);
  }
  return out;
}

/** Поля `turn` для `livekit.json`: relay только к SFU этой машины. */
export function peerRules(nodeIp) {
  // Узел на IPv6 (`--ip` бывает и таким): весь IPv4 закрыт, IPv6 — всё, кроме узла. «Закрытость» IPv6-узла
  // не разбираем: адрес узла, который вводят в `--ip`, публичный.
  if (ipv4(nodeIp) === null) return { deny_peer_cidrs: ['0.0.0.0/0', ...complement6(nodeIp)] };
  return {
    deny_peer_cidrs: [...complement(nodeIp), '::/0'],
    ...(restricted(nodeIp) ? { allow_restricted_peer_cidrs: [`${nodeIp}/32`] } : {}),
  };
}

/**
 * Пустит ли LiveKit 1.13.6 relay к адресу `peer` при таких полях `turn` (порядок — как в `turn.go`:
 * «закрытый» — только из `allow_restricted_peer_cidrs`, затем любой из `deny_peer_cidrs` — отказ).
 * «Закрытость» IPv6 проверяется грубо: loopback, link-local, multicast, ULA и `::`.
 */
export function permits(turn, peer) {
  const n = ipv4(peer);
  if (n === null) {
    const v6 = ipv6(peer);
    if (v6 === null) return false;
    const inside6 = (list) =>
      (list ?? []).some((net) => {
        const [address, length] = net.split('/');
        const start = ipv6(address);
        if (start === null) return false;
        const shift = BigInt(128 - Number(length));
        return v6 >> shift === start >> shift;
      });
    const closed = v6 <= 1n || v6 >> 118n === 0x3fan || v6 >> 120n === 0xffn || v6 >> 121n === 0x7en;
    if (closed && !inside6(turn.allow_restricted_peer_cidrs)) return false;
    return !inside6(turn.deny_peer_cidrs);
  }
  const inside = (list) => (list ?? []).map(cidr).filter(Boolean).some((range) => contains(range, n));
  if (restricted(peer) && !inside(turn.allow_restricted_peer_cidrs)) return false;
  return !inside(turn.deny_peer_cidrs);
}
