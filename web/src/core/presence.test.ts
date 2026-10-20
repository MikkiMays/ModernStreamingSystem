import { describe, expect, it, vi } from 'vitest';
import { CONFIRM_EVERY_MS, Presence } from './presence';

const quiet = { speaking: () => false, camera: () => false };

describe('присутствие (A2): браузер сам говорит ядру, что за ним кто-то есть', () => {
  it('молчит, пока человек ничего не делал, — вопрос «Вы ещё здесь?» задаст ядро', () => {
    let now = 1_000;
    const send = vi.fn(() => Promise.resolve());
    const presence = new Presence(send, () => now);
    now += CONFIRM_EVERY_MS * 3;
    presence.tick(quiet);
    expect(send).not.toHaveBeenCalled();
  });

  it('подтверждает не чаще раза в интервал, если человек был здесь после прошлого раза', () => {
    let now = 1_000;
    const send = vi.fn(() => Promise.resolve());
    const presence = new Presence(send, () => now);
    now += 1_000;
    presence.touch();
    presence.tick(quiet);
    expect(send).not.toHaveBeenCalled();
    now += CONFIRM_EVERY_MS;
    presence.tick(quiet);
    expect(send).toHaveBeenCalledTimes(1);
    presence.touch();
    now += 1_000;
    presence.tick(quiet);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('голос и включённая камера — тоже присутствие', async () => {
    let now = 1_000;
    const send = vi.fn(() => Promise.resolve());
    const presence = new Presence(send, () => now);
    now += CONFIRM_EVERY_MS + 1;
    presence.tick({ speaking: () => true, camera: () => false });
    expect(send).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    now += CONFIRM_EVERY_MS + 1;
    presence.tick({ speaking: () => false, camera: () => true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('ответ на вопрос уходит сразу, без ожидания интервала', async () => {
    const send = vi.fn(() => Promise.resolve());
    const presence = new Presence(send, () => 5_000);
    await presence.confirm();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('неудачная отправка не съедает интервал: следующий проход попробует снова', async () => {
    let now = 1_000;
    const send = vi.fn(() => Promise.reject(new Error('offline')));
    const presence = new Presence(send, () => now);
    now += CONFIRM_EVERY_MS + 1;
    presence.touch();
    presence.tick(quiet);
    await Promise.resolve();
    await Promise.resolve();
    now += 15_000;
    presence.tick(quiet);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
