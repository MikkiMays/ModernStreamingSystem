import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { check, findings, jsonStrings, pythonText } from "./product-voice.mjs";

test("catches what a product does not say", () => {
  for (const text of [
    "Исходный код — https://github.com/someone/cord",
    "Cord — open-source: поставьте себе сервер",
    "Укажите адрес сервера",
    "Запустите setup.sh на своём сервере",
    "Скачайте из репозитория",
    "Это опенсорс",
    "Свой сервер за пять минут",
  ])
    assert.ok(check(text).length > 0, text);
});

test("lets ordinary product words through", () => {
  for (const text of [
    "Сервер не ответил за восемь секунд",
    "Пароль сервера",
    "Обновления Cord ставит сам при запуске",
    "Можно написать и автору Cord в Telegram",
    "Время ответа сервера",
    "Встречи на этом сервере",
    "Отпечаток адреса: сам адрес сервер не хранит",
  ])
    assert.deepEqual(check(text), [], text);
});

test("walks every string of a catalog with its key", () => {
  assert.deepEqual(
    [...jsonStrings({ a: { b: "x", c: ["y"] }, d: 1 })],
    [
      ["a.b", "x"],
      ["a.c[0]", "y"],
    ],
  );
  assert.deepEqual(
    pythonText('# github.com в комментарии\nHELP = "Cord"').map(([, line]) => line),
    ['HELP = "Cord"'],
  );
});

test("the repository is clean", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  assert.deepEqual(findings(root), []);
});
