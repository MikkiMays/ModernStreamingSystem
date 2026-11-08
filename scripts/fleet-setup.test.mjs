import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, base32, hashPassword, newTotpSecret, otpauth, parseEnv, renderEnv } from "./fleet-setup.mjs";

test("хэш пароля — в формате, который читает fleet/auth.py", () => {
  const stored = hashPassword("пароль-пульта", Buffer.from("0123456789abcdef"));
  const [scheme, params, salt, hash] = stored.split("$");
  assert.equal(scheme, "scrypt");
  assert.equal(params, "32768,8,1");
  assert.equal(Buffer.from(salt, "base64").toString(), "0123456789abcdef");
  assert.equal(Buffer.from(hash, "base64").length, 32);
  // Та же соль — тот же хэш; другая соль — другой.
  assert.equal(hashPassword("пароль-пульта", Buffer.from("0123456789abcdef")), stored);
  assert.notEqual(hashPassword("пароль-пульта"), stored);
});

test("base32 — как RFC 4648 без дополнения", () => {
  assert.equal(base32(Buffer.from("12345678901234567890")), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(newTotpSecret().length, 32);
  assert.match(newTotpSecret(), /^[A-Z2-7]+$/);
  assert.match(otpauth("ABC", "admin.callcord.ru"), /^otpauth:\/\/totp\/.*secret=ABC&issuer=Cord/);
});

test("apply — только названные поля, с проверкой", () => {
  const current = { FLEET_PASSWORD_HASH: "old", FLEET_TOTP_SECRET: "S" };
  const next = apply(current, { allow: "203.0.113.0/24, 198.51.100.7/32", admin: "admin.callcord.ru", core: ["a=password:x", "meet=key:y"] });
  assert.equal(next.FLEET_PASSWORD_HASH, "old");
  assert.equal(next.FLEET_ALLOW_IPS, "203.0.113.0/24,198.51.100.7/32");
  assert.equal(next.FLEET_ADMIN_HOST, "admin.callcord.ru");
  assert.equal(next.FLEET_CORE_A, "password:x");
  assert.equal(next.FLEET_CORE_MEET, "key:y");
  assert.throws(() => apply(current, { allow: "home" }), /CIDR/);
  assert.throws(() => apply(current, { executor: "bash" }), /dry-run или ssh/);
  assert.throws(() => apply(current, { executor: "ssh" }), /ssh-machines/);
  assert.throws(() => apply(current, { core: ["a=plain"] }), /password:/);
  const live = apply(current, { executor: "ssh", "ssh-machines": "meet,cordcam" });
  assert.equal(live.FLEET_EXECUTOR, "ssh");
  assert.equal(live.FLEET_SSH_MACHINES, "meet,cordcam");
  assert.equal(apply(live, { executor: "dry-run" }).FLEET_EXECUTOR, "dry-run");
});

test("файл читается и пишется без потерь", () => {
  const text = renderEnv({ A: "1", B: "x=y", C: undefined });
  assert.equal(text, "A=1\nB=x=y\n");
  assert.deepEqual(parseEnv(text + "# комментарий\n"), { A: "1", B: "x=y" });
});
