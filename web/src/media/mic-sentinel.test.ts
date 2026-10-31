import { describe, expect, it, vi } from 'vitest';
import { MicSentinel, MUTED_FOR_MS } from './mic-sentinel';

function setup({ visible = true } = {}) {
  let now = 0;
  const raw = { readyState: 'live', muted: false };
  const track = { mediaStreamTrack: raw, restartTrack: vi.fn(async () => {}) };
  const restarted = vi.fn();
  const sentinel = new MicSentinel({
    track: () => track,
    wanted: () => true,
    visible: () => visible,
    now: () => now,
    restarted,
  });
  return { sentinel, raw, track, restarted, tick: (ms: number) => (now += ms) };
}

describe('сторож микрофона после фона (R147)', () => {
  it('живой и не заглушённый — не трогаем', async () => {
    const { sentinel, track } = setup();
    await sentinel.check();
    expect(track.restartTrack).not.toHaveBeenCalled();
  });

  it('дорожка кончилась (звонок, чужое приложение) — перезахват сразу', async () => {
    const { sentinel, raw, track, restarted } = setup();
    raw.readyState = 'ended';
    await sentinel.check();
    expect(track.restartTrack).toHaveBeenCalledTimes(1);
    expect(restarted).toHaveBeenCalledWith('ended');
  });

  it('заглушена системой дольше двух секунд на экране — перезахват; короче — ждём', async () => {
    const { sentinel, raw, track, tick, restarted } = setup();
    raw.muted = true;
    await sentinel.check();
    tick(MUTED_FOR_MS - 1);
    await sentinel.check();
    expect(track.restartTrack).not.toHaveBeenCalled();
    tick(1);
    await sentinel.check();
    expect(track.restartTrack).toHaveBeenCalledTimes(1);
    expect(restarted).toHaveBeenCalledWith('muted');
  });

  it('в фоне заглушённую не трогаем: система снимет заглушку сама', async () => {
    const { sentinel, raw, track, tick } = setup({ visible: false });
    raw.muted = true;
    await sentinel.check();
    tick(MUTED_FOR_MS * 5);
    await sentinel.check();
    expect(track.restartTrack).not.toHaveBeenCalled();
  });

  it('микрофон выключен человеком — сторож молчит', async () => {
    const track = {
      mediaStreamTrack: { readyState: 'ended', muted: false },
      restartTrack: vi.fn(async () => {}),
    };
    const sentinel = new MicSentinel({ track: () => track, wanted: () => false, visible: () => true });
    await sentinel.check();
    expect(track.restartTrack).not.toHaveBeenCalled();
  });

  it('перезахват не удался — без ошибки, следующий такт попробует снова', async () => {
    const { sentinel, raw, track } = setup();
    raw.readyState = 'ended';
    track.restartTrack.mockRejectedValueOnce(new Error('NotAllowedError'));
    await expect(sentinel.check()).resolves.toBeUndefined();
    await sentinel.check();
    expect(track.restartTrack).toHaveBeenCalledTimes(2);
  });
});
