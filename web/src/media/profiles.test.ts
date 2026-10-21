import { describe, expect, it } from 'vitest';
import { cameraOptions, fitSource, forcedCameraConstraints, screenHint, screenOptions } from './profiles';

describe('screen profiles', () => {
  it('preserves portrait, ultrawide and conventional source geometry', () => {
    expect(fitSource(1080, 1920, 720)).toEqual({ width: 720, height: 1280 });
    expect(fitSource(5120, 1440, 1440)).toEqual({ width: 2560, height: 720 });
    expect(fitSource(3840, 2160, 1440)).toEqual({ width: 2560, height: 1440 });
    expect(fitSource(640, 480, 1080)).toEqual({ width: 640, height: 480 });
  });
  /**
   * Выбранное — нижняя граница (R91, X10): один слой, screencast-режим, разрешение никогда не
   * понижается ни нашим кодом, ни браузером. Зритель со слабым каналом получает меньше кадров того
   * же размера — временные слои у VP9/AV1.
   */
  it('отдаёт выбранный уровень одним слоем без понижения разрешения', () => {
    const options = screenOptions({ resolution: 1440, fps: 60 }, 'av1');
    expect(options.screenShareEncoding?.maxBitrate).toBe(16000000);
    expect(options.screenShareEncoding?.maxFramerate).toBe(60);
    expect(options.screenShareEncoding?.priority).toBe('high');
    expect(options.backupCodec).toEqual({ codec: 'vp8' });
    expect(options.simulcast).toBe(false);
    expect(options.screenShareSimulcastLayers).toBeUndefined();
    expect(options.degradationPreference).toBe('maintain-resolution');
    expect(options.scalabilityMode).toBe('L1T3');
    expect(screenHint).toBe('detail');
  });

  it('у H.264 и VP8 временных слоёв не просит, но и разрешение не трогает', () => {
    for (const codec of ['h264', 'vp8'] as const) {
      const options = screenOptions({ resolution: 1080, fps: 30 }, codec);
      expect(options.scalabilityMode).toBeUndefined();
      expect(options.simulcast).toBe(false);
      expect(options.degradationPreference).toBe('maintain-resolution');
      expect(options.backupCodec).toBe(false);
    }
  });

  it('камера по-прежнему кладёт под выбранный уровень ступень 720p', () => {
    const camera = cameraOptions({ resolution: 1080, fps: 60 });
    expect(camera.videoSimulcastLayers?.map((layer) => layer.height)).toEqual([360, 720]);
  });

  /** «Авто» нет: любой уровень — выбранный, и держит частоту, а не торгуется ею. */
  it('публикует выбранное сразу и держит частоту у экрана и у камеры', () => {
    const screen = screenOptions({ resolution: 720, fps: 30 }, 'vp8');
    expect(screen.screenShareEncoding).toMatchObject({ maxBitrate: 3000000, maxFramerate: 30 });
    expect(screen.degradationPreference).toBe('maintain-resolution');
    const camera = cameraOptions({ resolution: 720, fps: 30 });
    expect(camera.videoEncoding).toEqual({ maxBitrate: 3000000, maxFramerate: 30 });
    expect(camera.degradationPreference).toBe('maintain-framerate');
    expect(camera.simulcast).toBe(true);
  });

  /**
   * Частоту нельзя задать сверху: и `maxFramerate`, и битрейт только ограничивают. Камера,
   * которая в полумраке удлиняет выдержку, укладывается в любой такой предел — и отдаёт
   * двадцать кадров там, где просили тридцать. Нижнюю границу задаёт только `min`.
   */
  it('выбранную частоту требует', () => {
    const asked = forcedCameraConstraints({ resolution: 1080, fps: 60 });
    expect(asked[0]).toEqual({
      width: { min: 1920, ideal: 1920 },
      height: { min: 1080, ideal: 1080 },
      frameRate: { min: 60, ideal: 60 },
    });
  });

  /**
   * Камера, умеющая 60 кадров только в 720p, обязана отдать выбранные 1080p, а не подменить
   * их частотой: «Качество» в списке стоит выше «Плавности», и жёстким остаётся именно кадр.
   */
  it('уступает частотой, а не размером кадра', () => {
    const asked = forcedCameraConstraints({ resolution: 1080, fps: 60 });
    expect(asked.map((step) => step.frameRate)).toEqual([
      { min: 60, ideal: 60 },
      { ideal: 60 },
      { ideal: 60 },
    ]);
    // Кадр держится жёстко ровно до последней просьбы — той, где отпущено всё.
    expect(asked.slice(0, 2).every((step) => 'min' in (step.width as { min?: number }))).toBe(true);
    expect(asked.at(-1)!.width).toEqual({ ideal: 1920 });
  });

  /** Просить больше, чем устройство умеет, — это отказ вместо картинки. */
  it('не требует у камеры того, чего она о себе не заявляла', () => {
    const modest = forcedCameraConstraints({ resolution: 1440, fps: 60 }, {
      width: { max: 1280 },
      height: { max: 720 },
      frameRate: { max: 30 },
    } as MediaTrackCapabilities);
    expect(modest[0]).toEqual({
      width: { min: 1280, ideal: 1280 },
      height: { min: 720, ideal: 720 },
      frameRate: { min: 30, ideal: 30 },
    });
  });
});
