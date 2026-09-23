import { describe, expect, it } from 'vitest';
import { fakeCameraTrack } from './fake-track';
import { retune } from './retune';

describe('ступень лестницы на работающей дорожке', () => {
  it('меняет слои у того же отправителя, а не публикует дорожку заново', async () => {
    const { track, sender, lock, layers } = fakeCameraTrack();
    expect(await retune(track, { resolution: 1080, fps: 60 })).toBe(true);
    expect(sender.setParameters).toHaveBeenCalledOnce();
    expect(lock.lock).toHaveBeenCalledOnce();
    const [q, h, f] = layers();
    expect(f).toMatchObject({ scaleResolutionDownBy: 1440 / 1080, maxBitrate: 10000000, maxFramerate: 60 });
    // Подпорки мельче новой ступени — остаются собой.
    expect(h).toMatchObject({ scaleResolutionDownBy: 2, maxBitrate: 2000000, maxFramerate: 30 });
    expect(q).toMatchObject({ scaleResolutionDownBy: 4, maxBitrate: 500000, maxFramerate: 15 });
  });

  it('возвращается наверх от опубликованных подпорок, а не от ужатых', async () => {
    const { track, layers } = fakeCameraTrack();
    await retune(track, { resolution: 720, fps: 30 });
    // На 720p подпорка того же размера была бы второй копией верхнего слоя — она ужимается вдвое.
    expect(layers().map((layer) => layer.scaleResolutionDownBy)).toEqual([8, 4, 2]);
    await retune(track, { resolution: 1440, fps: 60 });
    expect(layers().map((layer) => layer.scaleResolutionDownBy)).toEqual([4, 2, 1]);
    expect(layers().map((layer) => layer.maxBitrate)).toEqual([500000, 2000000, 16000000]);
  });

  it('пересчитывает подпорки, когда захват вырос', async () => {
    const { track, settings, layers } = fakeCameraTrack({ width: 1920, height: 1080 });
    // Запись о слоях снимается с того кадра, с которым публиковали: 1080p → подпорки 270p и 540p.
    await retune(track, { resolution: 1080, fps: 30 });
    Object.assign(settings, { width: 2560, height: 1440 });
    await retune(track, { resolution: 1440, fps: 30 });
    expect(layers().map((layer) => layer.scaleResolutionDownBy)).toEqual([1440 / 270, 1440 / 540, 1]);
  });

  it('не зажигает слой, который LiveKit погасил битрейтом (Firefox)', async () => {
    const { track, sender, layers } = fakeCameraTrack();
    const params = sender.getParameters();
    params.encodings[0]!.maxBitrate = 10;
    await sender.setParameters(params);
    await retune(track, { resolution: 1080, fps: 30 });
    expect(layers()[0]!.maxBitrate).toBe(10);
  });

  it('отказывается, если слоёв не столько, сколько опубликовали', async () => {
    const { track, sender } = fakeCameraTrack();
    Object.assign(track, { encodings: [{ rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 6000000 }] });
    expect(await retune(track, { resolution: 1080, fps: 30 })).toBe(false);
    expect(sender.setParameters).not.toHaveBeenCalled();
  });
});
