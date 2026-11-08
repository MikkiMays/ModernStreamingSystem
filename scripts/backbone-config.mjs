/**
 * Магистраль между узлами Cord: mTLS по TCP на `caddy-l4` (`docs/architecture/distributed-media.md`, §5.5′).
 *
 * ЗАЧЕМ ТАК. UDP между узлом управления A и медиаузлом B режет DDoS-фильтр хостера A (замер 07.11.2026),
 * поэтому WireGuard там не живёт. Нужен туннель по TCP, который (1) не требует нового софта на узлах,
 * (2) пускает только свои узлы, (3) прозрачен для служб. Тот же образ `livekit/caddyl4`, что уже
 * держит 443 на каждом узле, умеет и это: слушать один порт, смотреть SNI ClientHello, требовать
 * клиентский сертификат нашего ЦС и отдавать поток на локальный порт службы.
 *
 * КАК ЧИТАТЬ. Каждый узел — и сервер, и клиент магистрали. Серверная сторона: `:7443` → по SNI
 * `<служба>.<узел>.cord` → `127.0.0.1:<порт службы>`. Клиентская: `127.0.0.1:<локальный порт>` →
 * `<ip соседа>:7443` с SNI службы соседа и своим сертификатом. Службы видят только 127.0.0.1 — ядро
 * на A зовёт Twirp узла `hel` как `http://127.0.0.1:21000`, LiveKit узла шлёт вебхуки в
 * `http://127.0.0.1:18090`. Переезд на WireGuard — замена `dial` в клиентских маршрутах, службы не
 * трогаются.
 */

/** Порт магистрали на каждом узле. Брандмауэр пускает на него только адреса своих узлов. */
export const BACKBONE_PORT = 7443;

/** Что узел управления отдаёт медиаузлам: ядро (forward_auth сигналинга) и крюки (вебхуки LiveKit). */
export const CONTROL_SERVICES = { core: 8080, hooks: 8090 };

/** Что медиаузел отдаёт узлу управления: Twirp/сигналинг SFU и метрики. */
export const NODE_SERVICES = { livekit: 7880, metrics: 6789, node: 9100, gateway: 2019, probe: 9402 };

/** Где на медиаузле отвечает плоскость управления (локальные порты клиентской стороны). */
export const NODE_LOCAL = { core: 18080, hooks: 18090 };

/** Пути сертификатов внутри контейнера `backbone` (том `./pki` узла). */
const PKI = { ca: "/pki/ca.crt", crt: "/pki/node.crt", key: "/pki/node.key" };

export const NODE_ID = /^[a-z][a-z0-9-]{0,15}$/;

export function assertNodeId(id) {
  if (!NODE_ID.test(id ?? ""))
    throw new Error(`Node id must match ${NODE_ID} (got ${JSON.stringify(id)})`);
  return id;
}

/**
 * Локальные порты узла управления для медиаузла с номером `index` (1, 2, …): 21000, 22000, …
 * Номер постоянен на всю жизнь узла (хранится в `nodes.json`), иначе ядро и scrape-конфиг разъехались бы.
 */
export function controlPorts(index) {
  if (!Number.isInteger(index) || index < 1 || index > 40)
    throw new Error("Node index must be an integer from 1 to 40");
  const base = 20000 + 1000 * index;
  return Object.fromEntries(Object.keys(NODE_SERVICES).map((service, i) => [service, base + i]));
}

export const sni = (service, node) => `${service}.${assertNodeId(node)}.cord`;

const clientAuth = {
  client_authentication: {
    ca: { provider: "file", pem_files: [PKI.ca] },
    mode: "require_and_verify",
  },
};

/** Серверный маршрут: соединение с этим SNI и верным клиентским сертификатом — на локальный порт. */
function serve(service, node, port) {
  return {
    match: [{ tls: { sni: [sni(service, node)] } }],
    handle: [
      { handler: "tls", connection_policies: [clientAuth] },
      { handler: "proxy", upstreams: [{ dial: [`127.0.0.1:${port}`] }] },
    ],
  };
}

/** Клиентский слушатель: 127.0.0.1:<порт> → сосед:7443 с SNI его службы и нашим сертификатом. */
function reach(localPort, peerIp, service, peerNode) {
  return {
    listen: [`127.0.0.1:${localPort}`],
    routes: [
      {
        handle: [
          {
            handler: "proxy",
            upstreams: [
              {
                dial: [`${peerIp}:${BACKBONE_PORT}`],
                tls: {
                  server_name: sni(service, peerNode),
                  client_certificate_file: PKI.crt,
                  client_certificate_key_file: PKI.key,
                  ca: { provider: "file", pem_files: [PKI.ca] },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Полная конфигурация `backbone` одного узла.
 *
 * @param self      `{ id }` — чей это узел (SNI серверных маршрутов)
 * @param serves    `{ service: port }` — что отдаём соседям
 * @param reaches   `[{ node, ip, services: { service: localPort } }]` — к кому и как дозваниваемся
 */
export function createBackbone({ self, serves, reaches }) {
  assertNodeId(self.id);
  const routes = Object.entries(serves).map(([service, port]) => serve(service, self.id, port));
  const servers = {};
  if (routes.length) servers.backbone = { listen: [`:${BACKBONE_PORT}`], routes };
  const taken = new Set();
  for (const peer of reaches)
    for (const [service, localPort] of Object.entries(peer.services)) {
      if (taken.has(localPort)) throw new Error(`Local port ${localPort} is used twice in backbone`);
      taken.add(localPort);
      servers[`${service}-${peer.node}`] = reach(localPort, peer.ip, service, peer.node);
    }
  return {
    admin: { disabled: true },
    logging: { logs: { default: { level: "WARN" } } },
    apps: {
      ...(routes.length
        ? { tls: { certificates: { load_files: [{ certificate: PKI.crt, key: PKI.key }] } } }
        : {}),
      layer4: { servers },
    },
  };
}

/** Магистраль медиаузла: отдаёт SFU и метрики узлу управления, дозванивается до ядра и крюков. */
export function nodeBackbone(node, control) {
  return createBackbone({
    self: { id: node.id },
    serves: NODE_SERVICES,
    reaches: [{ node: control.id, ip: control.ip, services: NODE_LOCAL }],
  });
}

/** Магистраль узла управления: отдаёт ядро и крюки, дозванивается до каждого медиаузла. */
export function controlBackbone(control, nodes) {
  return createBackbone({
    self: { id: control.id },
    serves: CONTROL_SERVICES,
    reaches: nodes.map((node) => ({ node: node.id, ip: node.ip, services: controlPorts(node.index) })),
  });
}
