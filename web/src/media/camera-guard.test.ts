import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKOFF_MS,
  CameraGuard,
  ENDED_GRACE_MS,
  MUTED_FOR_MS,
  OWN_DEVICE_TRIES,
  STALL_MS,
  type CameraKind,
  type CameraLook,
  type HealRequest,
} from './camera-guard';

function harness(overrides: Partial<CameraLook> = {}) {
  const look: CameraLook = {
    raw: { readyState: 'live', muted: false },
    silenced: false,
    framesEncoded: 0,
    watched: true,
    ...overrides,
  };
  const notes: { kind: CameraKind; detail?: string }[] = [];
  const healing: boolean[] = [];
  const heals: HealRequest[] = [];
  const state = { wanted: true, busy: false, connected: true, visible: true };
  const heal = vi.fn(async (request: HealRequest) => {
    heals.push(request);
  });
  // Неудачная попытка — тоже попытка: считаем по вызовам, а не по успешным записям.
  const tries = () => heal.mock.calls.length;
  const denied = vi.fn();
  const guard = new CameraGuard({
    look: () => look,
    wanted: () => state.wanted,
    busy: () => state.busy,
    connected: () => state.connected,
    visible: () => state.visible,
    heal,
    denied,
    note: (kind, detail) => notes.push({ kind, detail }),
    healing: (active) => healing.push(active),
    now: () => Date.now(),
  });
  /** Прошло `ms` по такту раз в секунду, как в сессии. */
  const ticks = async (ms: number) => {
    for (let passed = 0; passed < ms; passed += 1000) {
      await vi.advanceTimersByTimeAsync(1000);
      await guard.check();
    }
  };
  return { guard, look, notes, healing, heals, heal, denied, state, ticks, tries };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('сторож камеры (R189, И4)', () => {
  it('живая камера — ничего не делает и ничего не пишет', async () => {
    const { guard, look, notes, heal } = harness();
    for (let i = 0; i < 10; i++) {
      look.framesEncoded = i * 30;
      await guard.check();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(heal).not.toHaveBeenCalled();
    expect(notes).toEqual([]);
    expect(guard.active).toBe(false);
  });

  it('заглушённая не человеком публикация — перезахват сразу, запись в журнал, «переподключается»', async () => {
    const h = harness({ silenced: true });
    await h.guard.check();
    expect(h.heals).toEqual([{ reason: 'silenced', failures: 0, anyDevice: false }]);
    expect(h.notes).toEqual([{ kind: 'camera-silenced', detail: undefined }]);
    expect(h.healing).toEqual([true]);
    // Следующий такт подтверждает: камера жива — эпизод закрыт, «вылечена».
    h.look.silenced = false;
    await h.guard.check();
    expect(h.notes.at(-1)).toEqual({ kind: 'camera-healed', detail: 'silenced' });
    expect(h.healing).toEqual([true, false]);
    expect(h.guard.active).toBe(false);
  });

  it('захват кончился: перезахват после короткой льготы', async () => {
    const h = harness({ raw: { readyState: 'ended', muted: false } });
    await h.guard.check();
    expect(h.heal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ENDED_GRACE_MS);
    await h.guard.check();
    expect(h.heals.map((r) => r.reason)).toEqual(['ended']);
    expect(h.notes[0]).toEqual({ kind: 'camera-ended', detail: undefined });
  });

  it('заглушка системы дольше порога при видимой странице — перезахват; в фоне — ждём', async () => {
    const h = harness({ raw: { readyState: 'live', muted: true } });
    h.state.visible = false;
    await h.ticks(MUTED_FOR_MS + 2000);
    expect(h.heal).not.toHaveBeenCalled();
    h.state.visible = true;
    await h.guard.check();
    expect(h.heals.map((r) => r.reason)).toEqual(['muted']);
    expect(h.notes[0]?.kind).toBe('camera-muted');
  });

  it('короткая заглушка (кадры вернулись) — не повод', async () => {
    const h = harness({ raw: { readyState: 'live', muted: true } });
    await h.guard.check();
    await vi.advanceTimersByTimeAsync(MUTED_FOR_MS - 500);
    await h.guard.check();
    h.look.raw = { readyState: 'live', muted: false };
    await h.ticks(5000);
    expect(h.heal).not.toHaveBeenCalled();
  });

  it('кадры не кодируются при живом подписчике — перезахват; без подписчика или спящем слое — нет', async () => {
    const h = harness({ framesEncoded: 100, watched: false });
    await h.ticks(STALL_MS + 2000);
    expect(h.heal).not.toHaveBeenCalled();
    h.look.watched = true;
    await h.ticks(STALL_MS + 1000);
    expect(h.heals.map((r) => r.reason)).toEqual(['stalled']);
    expect(h.notes[0]?.kind).toBe('camera-stalled');
  });

  it('публикации нет, хотя камера нужна и связь есть, — публикуем заново; без связи — ждём', async () => {
    const h = harness({ raw: null });
    h.state.connected = false;
    await h.guard.check();
    expect(h.heal).not.toHaveBeenCalled();
    h.state.connected = true;
    await h.guard.check();
    expect(h.heals.map((r) => r.reason)).toEqual(['missing']);
  });

  it('отступ 1/2/4/8/15 с без предела, с третьей неудачи — любая камера; «вылечена» один раз в конце', async () => {
    const h = harness({ silenced: true });
    h.heal.mockRejectedValue(new DOMException('busy', 'NotReadableError'));
    await h.guard.check();
    const expected = [...BACKOFF_MS, 15_000, 15_000, 15_000];
    for (const gap of expected) {
      const before = h.tries();
      await h.ticks(gap - 1000);
      expect(h.tries()).toBe(before);
      await h.ticks(1000);
      expect(h.tries()).toBe(before + 1);
    }
    expect(h.heal.mock.calls.map(([r]) => r.anyDevice)).toEqual([
      false,
      false,
      false,
      ...Array(expected.length - OWN_DEVICE_TRIES + 1).fill(true),
    ]);
    expect(h.notes.filter((n) => n.kind === 'camera-heal-failed')).toHaveLength(expected.length + 1);
    expect(h.notes.filter((n) => n.kind === 'camera-silenced')).toHaveLength(1);
    // Устройство вернулось.
    h.heal.mockResolvedValue(undefined);
    await h.ticks(15_000);
    h.look.silenced = false;
    await h.guard.check();
    expect(h.notes.at(-1)?.kind).toBe('camera-healed');
    expect(h.healing).toEqual([true, false]);
  });

  it('перезахват прошёл, а камера снова мёртвая — это неудача, а не новый эпизод', async () => {
    const h = harness({ silenced: true });
    await h.guard.check();
    expect(h.heals).toHaveLength(1);
    // Подтверждающий такт: всё ещё заглушена.
    await vi.advanceTimersByTimeAsync(1000);
    await h.guard.check();
    expect(h.heals).toHaveLength(1);
    expect(h.notes.map((n) => n.kind)).toEqual(['camera-silenced', 'camera-heal-failed']);
    await h.ticks(BACKOFF_MS[0]);
    expect(h.heals).toHaveLength(2);
    expect(h.notes.filter((n) => n.kind === 'camera-silenced')).toHaveLength(1);
  });

  it('`devicechange` и возврат на вкладку — попытка сразу, не дожидаясь отступа', async () => {
    const h = harness({ silenced: true });
    h.heal.mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'));
    await h.guard.check();
    await h.ticks(BACKOFF_MS[0]);
    await h.ticks(BACKOFF_MS[1] - 1000);
    expect(h.tries()).toBe(2);
    await h.guard.poke();
    expect(h.tries()).toBe(3);
  });

  it('отказ в разрешении не лечится: камера выключается, сторож молчит до следующего нажатия', async () => {
    const h = harness({ silenced: true });
    h.heal.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await h.guard.check();
    expect(h.denied).toHaveBeenCalledOnce();
    expect(h.notes.map((n) => n.kind)).toEqual(['camera-silenced', 'camera-denied']);
    expect(h.healing).toEqual([true, false]);
    await h.ticks(60_000);
    expect(h.tries()).toBe(1);
    // Человек нажал на камеру снова — сторож опять в деле.
    h.guard.reset();
    h.heal.mockResolvedValue(undefined);
    await h.guard.check();
    expect(h.tries()).toBe(2);
  });

  it('не вмешивается, пока сессия занята камерой, и ничего не делает, когда камера не нужна', async () => {
    const h = harness({ silenced: true });
    h.state.busy = true;
    await h.ticks(5000);
    expect(h.heal).not.toHaveBeenCalled();
    h.state.busy = false;
    h.state.wanted = false;
    await h.ticks(5000);
    expect(h.heal).not.toHaveBeenCalled();
    expect(h.notes).toEqual([]);
  });

  it('человек выключил камеру посреди лечения — эпизод закрыт без «вылечена»', async () => {
    const h = harness({ silenced: true });
    h.heal.mockRejectedValue(new DOMException('busy', 'NotReadableError'));
    await h.guard.check();
    h.state.wanted = false;
    await h.guard.check();
    expect(h.healing).toEqual([true, false]);
    expect(h.guard.active).toBe(false);
    expect(h.notes.map((n) => n.kind)).not.toContain('camera-healed');
  });

  it('лечение не накладывается: пока идёт перезахват, следующий такт ждёт', async () => {
    const h = harness({ silenced: true });
    let finish!: () => void;
    h.heal.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    const first = h.guard.check();
    await h.guard.check();
    expect(h.heal).toHaveBeenCalledOnce();
    finish();
    await first;
  });
});
