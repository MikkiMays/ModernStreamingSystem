import { describe, expect, it, vi } from 'vitest';
import type { LocalVideoTrack } from 'livekit-client';
import { CameraBackground, ensureRawOnSenders } from './camera';
import { CordBackgroundProcessor } from './processor';

/*
  Фон у дорожки камеры встречи (R186, ревью A1, A4): обработчик с мёртвым выходом при живой камере
  ставится заново; `init` обработчика не бросает, когда движок отказал, — камера публикуется как есть.
*/

function fakeEffect(attach: () => Promise<MediaStreamTrack>) {
  return {
    attach: vi.fn(attach),
    setChoice: vi.fn(async () => {}),
    detach: vi.fn(),
  } as unknown as NonNullable<ConstructorParameters<typeof CordBackgroundProcessor>[2]>;
}

function fakeTrack(processor: CordBackgroundProcessor | undefined) {
  let current = processor;
  const track = {
    getProcessor: () => current,
    setProcessor: vi.fn(async (next: CordBackgroundProcessor) => {
      current = next;
      await next.init({ track: raw } as never);
    }),
    stopProcessor: vi.fn(async () => {
      current = undefined;
    }),
  };
  const raw = { readyState: 'live' } as MediaStreamTrack;
  return track;
}

describe('фон у дорожки камеры встречи (R186)', () => {
  it('выход обработчика кончился, камера жива — обработчик ставится заново', async () => {
    const live = { readyState: 'live' } as MediaStreamTrack;
    const ended = { readyState: 'ended' } as MediaStreamTrack;
    const effect = fakeEffect(async () => live);
    const stale = new CordBackgroundProcessor({ kind: 'blur', strength: 'light' }, 'full', effect);
    stale.source = live;
    stale.processedTrack = ended;
    const track = fakeTrack(stale);
    const background = new CameraBackground(effect as never);
    await background.apply(track as never, { kind: 'blur', strength: 'strong' }, 'full');
    expect(track.stopProcessor).toHaveBeenCalledTimes(1);
    expect(track.setProcessor).toHaveBeenCalledTimes(1);
    expect(track.getProcessor()).not.toBe(stale);
    expect(track.getProcessor()?.processedTrack).toBe(live);
  });

  it('живой обработчик — только смена выбора, без переустановки', async () => {
    const live = { readyState: 'live' } as MediaStreamTrack;
    const effect = fakeEffect(async () => live);
    const healthy = new CordBackgroundProcessor({ kind: 'blur', strength: 'light' }, 'full', effect);
    healthy.source = live;
    healthy.processedTrack = live;
    const track = fakeTrack(healthy);
    await new CameraBackground().apply(track as never, { kind: 'blur', strength: 'strong' }, 'full');
    expect(track.setProcessor).not.toHaveBeenCalled();
    expect(track.stopProcessor).not.toHaveBeenCalled();
    expect(effect.setChoice).toHaveBeenCalledWith({ kind: 'blur', strength: 'strong' }, 'full');
  });

  it('«без фона» снимает обработчик; без обработчика — ничего не делает', async () => {
    const effect = fakeEffect(async () => ({ readyState: 'live' }) as MediaStreamTrack);
    const processor = new CordBackgroundProcessor({ kind: 'blur', strength: 'light' }, 'full', effect);
    const track = fakeTrack(processor);
    const background = new CameraBackground();
    await background.apply(track as never, { kind: 'none' }, 'full');
    expect(track.stopProcessor).toHaveBeenCalledTimes(1);
    expect(background.active).toBe(false);
    await background.apply(track as never, { kind: 'none' }, 'full');
    expect(track.stopProcessor).toHaveBeenCalledTimes(1);
  });

  it('init обработчика не бросает при отказе движка — камера уходит сырой (A4)', async () => {
    const effect = fakeEffect(async () => {
      throw new Error('insertable streams');
    });
    const processor = new CordBackgroundProcessor({ kind: 'blur', strength: 'light' }, 'full', effect);
    const raw = { readyState: 'live' } as MediaStreamTrack;
    await expect(processor.init({ track: raw } as never)).resolves.toBeUndefined();
    expect(processor.processedTrack).toBeUndefined();
    expect(processor.source).toBe(raw);
    await expect(processor.restart({ track: raw } as never)).resolves.toBeUndefined();
  });
});

describe('отправители после снятия фона (R189, И5)', () => {
  function senders(rawState: 'live' | 'ended', primaryTrack: unknown, backupState: 'live' | 'ended') {
    const raw = { readyState: rawState, clone: vi.fn(() => ({ readyState: 'live' })) };
    const sender = { track: primaryTrack, replaceTrack: vi.fn(async () => {}) };
    const backupSender = {
      track: { readyState: backupState },
      replaceTrack: vi.fn(async () => {}),
    };
    const backup = { mediaStreamTrack: { readyState: backupState }, sender: backupSender };
    const track = {
      mediaStreamTrack: raw,
      sender,
      simulcastCodecs: new Map([['h264', backup]]),
    } as unknown as LocalVideoTrack;
    return { track, raw, sender, backup, backupSender };
  }

  it('основной на остановленном генераторе, запасной на мёртвом клоне — оба переводятся на живой захват', async () => {
    const { track, raw, sender, backup, backupSender } = senders('live', { readyState: 'ended' }, 'ended');
    expect(await ensureRawOnSenders(track)).toBe('fixed');
    expect(sender.replaceTrack).toHaveBeenCalledWith(raw);
    expect(raw.clone).toHaveBeenCalledOnce();
    expect(backupSender.replaceTrack).toHaveBeenCalledWith(backup.mediaStreamTrack);
    expect(backup.mediaStreamTrack.readyState).toBe('live');
  });

  it('всё и так живое — ничего не трогаем; мёртвый захват — дело сторожа камеры', async () => {
    const fine = senders('live', null, 'live');
    (fine.sender as { track: unknown }).track = fine.raw;
    expect(await ensureRawOnSenders(fine.track)).toBe('ok');
    expect(fine.sender.replaceTrack).not.toHaveBeenCalled();
    expect(fine.backupSender.replaceTrack).not.toHaveBeenCalled();
    const dead = senders('ended', { readyState: 'ended' }, 'ended');
    expect(await ensureRawOnSenders(dead.track)).toBe('dead');
    expect(dead.sender.replaceTrack).not.toHaveBeenCalled();
  });
});
