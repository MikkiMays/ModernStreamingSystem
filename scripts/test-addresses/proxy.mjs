#!/usr/bin/env node
// Прокси «разных адресов» для автотестов и нагрузки на стенде (владелец 09.11: «создавать будто бы мнимые разные IP
// и создавать реальную ситуацию»). Браузер ходит на стенд через этот прокси (CONNECT), а прокси открывает каждое
// соединение со следующего адреса пула 10.77.x.x (интерфейс cordtest0, `test-addresses.sh up`). Путь до ядра тот же,
// что у людей: edge видит адрес соединения, PROXY v2 → шлюз → X-Real-IP → ядро; пределы защиты не ослаблены —
// просто у каждого «человека» свой адрес.
//
//   node scripts/test-addresses/proxy.mjs [--listen 127.0.0.1:18299] [--count 200] [--net 10.77]
import net from "node:net";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const [host, port] = arg("listen", "127.0.0.1:18299").split(":");
const count = Number(arg("count", "200"));
const prefix = arg("net", "10.77");
const address = (i) => `${prefix}.${Math.floor(i / 250)}.${(i % 250) + 1}`;
let next = 0;
const used = new Map();

const server = net.createServer((client) => {
  client.once("data", (head) => {
    const line = head.toString("latin1").split("\r\n", 1)[0];
    const match = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]$/.exec(line);
    if (!match) {
      client.end("HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n");
      return;
    }
    const localAddress = address(next++ % count);
    used.set(localAddress, (used.get(localAddress) ?? 0) + 1);
    const upstream = net.connect({ host: match[1], port: Number(match[2]), localAddress }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = head.subarray(head.indexOf("\r\n\r\n") + 4);
      if (rest.length) upstream.write(rest);
      client.pipe(upstream).pipe(client);
    });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", (error) => {
      if (!client.writableEnded) client.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${error.code ?? ""}`);
      close();
    });
    client.on("error", close);
  });
});
server.listen(Number(port), host, () =>
  console.log(`test-addresses: ${host}:${port} → ${count} адресов ${address(0)}…${address(count - 1)}`),
);
process.on("SIGUSR2", () => console.log(`test-addresses: соединений ${next}, адресов задействовано ${used.size}`));
