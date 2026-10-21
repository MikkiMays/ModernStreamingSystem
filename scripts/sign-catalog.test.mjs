import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPayload,
  checkPayload,
  jwkOf,
  kidOf,
  keygen,
  signCatalog,
  verifyCatalog,
} from "./sign-catalog.mjs";

const pair = generateKeyPairSync("ed25519");
const next = generateKeyPairSync("ed25519");
const stranger = generateKeyPairSync("ed25519");
const jwks = { keys: [jwkOf(pair.publicKey), jwkOf(next.publicKey)] };
const now = new Date("2026-10-20T12:00:00Z");

const source = {
  format: "cord.servers/1",
  servers: [
    {
      id: "nl-1",
      name: { ru: "Нидерланды", en: "Netherlands" },
      country: "NL",
      url: "https://cord.nikg.tech/",
      order: 10,
      default: true,
    },
  ],
};

test("payload: seq grows, dates come from the clock, servers pass through untouched", () => {
  const payload = buildPayload(source, { previousSeq: 4, now, days: 180 });
  assert.equal(payload.format, "cord.servers/1");
  assert.equal(payload.seq, 5);
  assert.equal(payload.issuedAt, "2026-10-20T12:00:00Z");
  assert.equal(payload.expiresAt, "2027-04-18T12:00:00Z");
  assert.deepEqual(payload.servers, source.servers);
  assert.equal(buildPayload(source, { previousSeq: 0, now, days: 1 }).seq, 1);
});

test("payload rules mirror contracts/server-catalog.v1.schema.json", () => {
  const good = buildPayload(source, { previousSeq: 0, now, days: 60 });
  assert.deepEqual(checkPayload(good), []);
  const one = source.servers[0];
  const broken = (servers, extra = {}) => checkPayload({ ...good, ...extra, servers });
  assert.match(broken([{ ...one, url: "http://cord.nikg.tech/" }]).join(), /url/);
  assert.match(broken([{ ...one, url: "https://cord.nikg.tech" }]).join(), /url/);
  assert.match(broken([{ ...one, url: "https://cord.nikg.tech/room" }]).join(), /url/);
  assert.match(broken([{ ...one, country: "nl" }]).join(), /country/);
  assert.match(broken([{ ...one, name: { en: "x" } }]).join(), /name/);
  assert.match(broken([{ ...one, name: { ru: "x".repeat(41) } }]).join(), /name/);
  assert.match(broken([{ ...one, id: "NL_1" }]).join(), /id/);
  assert.match(broken([{ ...one, default: false }]).join(), /default/);
  assert.match(broken([one, { ...one, id: "nl-2" }]).join(), /default/);
  assert.match(broken([one, { ...one, default: false }]).join(), /id/);
  assert.match(broken([]).join(), /servers/);
  assert.match(broken([{ ...one, extra: 1 }]).join(), /extra/);
  assert.match(broken([one], { format: "cord.servers/2" }).join(), /format/);
  assert.match(broken([one], { expiresAt: good.issuedAt }).join(), /expiresAt/);
});

test("sign → verify round trip with any listed key; kid is sha-256 of SPKI", () => {
  const payload = buildPayload(source, { previousSeq: 0, now, days: 60 });
  const jws = signCatalog(payload, pair.privateKey);
  const envelope = JSON.parse(jws);
  const header = JSON.parse(Buffer.from(envelope.signatures[0].protected, "base64url"));
  assert.deepEqual(header, { alg: "EdDSA", kid: kidOf(pair.publicKey) });
  assert.match(kidOf(pair.publicKey), /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(verifyCatalog(jws, jwks, { now }), payload);
  assert.deepEqual(verifyCatalog(signCatalog(payload, next.privateKey), jwks, { now }), payload);
});

test("verify refuses a stranger, a tampered payload, a rollback and an expired catalog", () => {
  const payload = buildPayload(source, { previousSeq: 6, now, days: 60 });
  const jws = signCatalog(payload, pair.privateKey);
  assert.throws(() => verifyCatalog(signCatalog(payload, stranger.privateKey), jwks, { now }), /подпись/);
  const tampered = JSON.parse(jws);
  tampered.payload = Buffer.from(JSON.stringify({ ...payload, seq: 99 })).toString("base64url");
  assert.throws(() => verifyCatalog(JSON.stringify(tampered), jwks, { now }), /подпись/);
  assert.throws(() => verifyCatalog(jws, jwks, { now, lastSeq: 8 }), /откат/);
  assert.deepEqual(verifyCatalog(jws, jwks, { now, lastSeq: 7 }), payload);
  const late = new Date(Date.parse(payload.expiresAt) + 31 * 24 * 3600 * 1000);
  assert.throws(() => verifyCatalog(jws, jwks, { now: late }), /срок/);
  const grace = new Date(Date.parse(payload.expiresAt) + 29 * 24 * 3600 * 1000);
  assert.deepEqual(verifyCatalog(jws, jwks, { now: grace }), payload);
});

test("keygen writes a private key only its owner can read and prints the public JWK", () => {
  const directory = mkdtempSync(join(tmpdir(), "catalog-key-"));
  const path = join(directory, "key.pem");
  const jwk = keygen(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.match(readFileSync(path, "utf8"), /BEGIN PRIVATE KEY/);
  assert.equal(jwk.kty, "OKP");
  assert.equal(jwk.crv, "Ed25519");
  assert.equal(jwk.alg, "EdDSA");
  assert.match(jwk.kid, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => keygen(path), /уже есть/);
});

test("the catalog committed in the repository verifies against contracts/catalog-keys.json", () => {
  const root = new URL("..", import.meta.url);
  const jws = readFileSync(new URL("infra/catalog/servers.jws", root), "utf8");
  const keys = JSON.parse(readFileSync(new URL("contracts/catalog-keys.json", root), "utf8"));
  const committed = JSON.parse(readFileSync(new URL("infra/catalog/servers.source.json", root), "utf8"));
  // Срок здесь не проверяется: сам каталог может истечь, а CI чужой ветки краснеть от этого не должен.
  const payload = verifyCatalog(jws, keys, { ignoreExpiry: true });
  assert.deepEqual(checkPayload(payload), []);
  assert.deepEqual(payload.servers, committed.servers, "servers.jws подписан не из servers.source.json");
});
