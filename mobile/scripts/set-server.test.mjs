import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mobile = fileURLToPath(new URL("..", import.meta.url));

/** Копия оболочки (скрипт, конфиг, offline.html) в temp — скрипт пишет файлы рядом с собой. */
async function shell() {
  const dir = await mkdtemp(join(tmpdir(), "cord-mobile-"));
  await mkdir(join(dir, "scripts"));
  await mkdir(join(dir, "www"));
  await cp(join(mobile, "scripts", "set-server.mjs"), join(dir, "scripts", "set-server.mjs"));
  await cp(join(mobile, "capacitor.config.json"), join(dir, "capacitor.config.json"));
  await cp(join(mobile, "www", "offline.html"), join(dir, "www", "offline.html"));
  return dir;
}

const run = (dir, env = {}, ...args) =>
  spawnSync(process.execPath, [join(dir, "scripts", "set-server.mjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, CORD_ANDROID_SERVER: "", ...env },
  });

test("в репозитории — продукт cordcam.ru, и оба файла называют его одинаково (R200, Р-110)", async () => {
  const dir = await shell();
  try {
    const config = JSON.parse(await readFile(join(dir, "capacitor.config.json"), "utf8"));
    assert.equal(config.server.url, "https://cordcam.ru");
    assert.match(await readFile(join(dir, "www", "offline.html"), "utf8"), /<meta name="cord-server" content="https:\/\/cordcam\.ru\/">/);
    const check = run(dir);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /^set-server: https:\/\/cordcam\.ru \(из репозитория\)/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("без адреса ничего не пишет, а расхождение файлов — ошибка сборки", async () => {
  const dir = await shell();
  try {
    const before = await readFile(join(dir, "capacitor.config.json"), "utf8");
    assert.equal(run(dir).status, 0);
    assert.equal(await readFile(join(dir, "capacitor.config.json"), "utf8"), before);
    const offline = join(dir, "www", "offline.html");
    await writeFile(offline, (await readFile(offline, "utf8")).replace("https://cordcam.ru/", "https://other.example.test/"));
    const broken = run(dir);
    assert.notEqual(broken.status, 0);
    assert.match(broken.stderr, /расходятся/);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("другая установка: CORD_ANDROID_SERVER пишет свой https-origin в конфиг и в кнопку «Повторить»", async () => {
  const dir = await shell();
  try {
    const set = run(dir, { CORD_ANDROID_SERVER: "https://meet.example.test/" });
    assert.equal(set.status, 0, set.stderr);
    const config = JSON.parse(await readFile(join(dir, "capacitor.config.json"), "utf8"));
    assert.equal(config.server.url, "https://meet.example.test");
    assert.match(await readFile(join(dir, "www", "offline.html"), "utf8"), /content="https:\/\/meet\.example\.test\/"/);
    assert.equal(run(dir).status, 0, "после записи файлы согласованы");
    for (const bad of ["http://meet.example.test", "https://meet.example.test/path", "meet.example.test"]) {
      const result = run(dir, {}, bad);
      assert.notEqual(result.status, 0, bad);
      assert.match(result.stderr, /https/);
    }
    assert.equal(JSON.parse(await readFile(join(dir, "capacitor.config.json"), "utf8")).server.url, "https://meet.example.test", "плохой адрес ничего не портит");
  } finally {
    await rm(dir, { recursive: true });
  }
});
