import { test } from "node:test";
import assert from "node:assert/strict";
import { diff, expand, key, load, nodeNames, payload } from "./dns.mjs";

test("узел — три имени, и только с допустимым id", () => {
  assert.deepEqual(nodeNames("msk", "cord.online"), ["msk.cord.online", "rtc-msk.cord.online", "turn-msk.cord.online"]);
  for (const bad of ["MSK", "1a", "a", "msk.evil", "rtc_msk", ""]) assert.throws(() => nodeNames(bad, "cord.online"));
});

test("зона разворачивается в записи: апекс, www, узлы, почта закрыта, CAA", () => {
  const records = expand("cord.example", {
    apex: ["192.0.2.1"],
    apexTtl: 60,
    www: true,
    nodes: { fra: "192.0.2.1", msk: "192.0.2.2" },
    hosts: { admin: "192.0.2.9" },
    mail: "none",
    caa: ["letsencrypt.org"],
  });
  const keys = records.map(key);
  assert.deepEqual(keys, [
    "A cord.example 192.0.2.1",
    "A www.cord.example 192.0.2.1",
    "A fra.cord.example 192.0.2.1",
    "A rtc-fra.cord.example 192.0.2.1",
    "A turn-fra.cord.example 192.0.2.1",
    "A msk.cord.example 192.0.2.2",
    "A rtc-msk.cord.example 192.0.2.2",
    "A turn-msk.cord.example 192.0.2.2",
    "A admin.cord.example 192.0.2.9",
    "MX cord.example .",
    "TXT cord.example v=spf1 -all",
    "TXT _dmarc.cord.example v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s",
    'CAA cord.example 0 issue "letsencrypt.org"',
    'CAA cord.example 0 issuewild ";"',
  ]);
  // Серое облако у всех (Р-109), TTL апекса — короткий: им переключают ядро при отказе.
  assert.ok(records.every((record) => record.proxied === false));
  assert.equal(records[0].ttl, 60);
  assert.equal(records[2].ttl, 1);
});

test("не адрес IPv4, чужая метка и повтор записи — ошибка, а не запись в зону", () => {
  assert.throws(() => expand("cord.example", { apex: ["2001:db8::1"] }), /IPv4/);
  assert.throws(() => expand("cord.example", { hosts: { "a.b": "192.0.2.1" } }), /метка/);
  assert.throws(() => expand("cord.example", { apex: ["192.0.2.1", "192.0.2.1"] }), /повторяется/);
  assert.throws(() => expand("cord.example", { mail: "google" }), /mail/);
});

test("сверка: создать недостающее, поправить ttl, назвать лишнее; TXT сравнивается без кавычек", () => {
  const desired = expand("cord.example", { apex: ["192.0.2.1"], apexTtl: 60, mail: "none" });
  const actual = [
    { id: "1", type: "A", name: "cord.example", content: "192.0.2.1", ttl: 1, proxied: false },
    { id: "2", type: "TXT", name: "cord.example", content: '"v=spf1 -all"', ttl: 1, proxied: false },
    { id: "3", type: "TXT", name: "_dmarc.cord.example", content: '"cord.example"', ttl: 1, proxied: false },
    { id: "4", type: "MX", name: "cord.example", content: "cord.example", priority: 0, ttl: 1, proxied: false },
  ];
  const { create, update, extra } = diff(desired, actual);
  assert.deepEqual(create.map(key), [
    "MX cord.example .",
    "TXT _dmarc.cord.example v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s",
  ]);
  assert.deepEqual(update.map((record) => [record.id, record.ttl]), [["1", 60]]);
  assert.deepEqual(extra.map((record) => record.id), ["3", "4"]);
  assert.deepEqual(diff(desired, desired.map((record, n) => ({ id: String(n), ...record }))), {
    create: [],
    update: [],
    extra: [],
  });
});

test("тело запроса: CAA — полями, TXT — в кавычках, MX — с приоритетом", () => {
  assert.deepEqual(payload({ type: "CAA", name: "c.example", content: '0 issuewild ";"', ttl: 1 }).data, {
    flags: 0,
    tag: "issuewild",
    value: ";",
  });
  assert.equal(payload({ type: "TXT", name: "c.example", content: "v=spf1 -all", ttl: 1 }).content, '"v=spf1 -all"');
  assert.equal(payload({ type: "MX", name: "c.example", content: ".", priority: 0, ttl: 1 }).priority, 0);
  assert.equal(payload({ type: "A", name: "c.example", content: "192.0.2.1", ttl: 60, proxied: false }).proxied, false);
});

test("файл зон в репозитории разворачивается: продукт — cord.online, пульт и стенд — в своей зоне", async () => {
  const zones = await load();
  assert.deepEqual(Object.keys(zones), ["cord.online", "callcord.ru"]);
  const names = (zone) => zones[zone].filter((record) => record.type === "A").map((record) => record.name);
  assert.ok(names("cord.online").includes("rtc-msk.cord.online"));
  assert.ok(names("callcord.ru").includes("admin.callcord.ru"));
  assert.ok(!names("cord.online").some((name) => name.startsWith("admin.")));
});
