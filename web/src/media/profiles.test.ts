import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupCodecPolicy } from 'livekit-client';
import type { PublishShape } from './codec-policy';
import {
  cameraCapture,
  cameraOptions,
  captureConstraints,
  fitSource,
  forcedCameraConstraints,
  modeOf,
  policyLevel,
  policySourceOf,
  screenHint,
  screenOptions,
  targetBitrate,
} from './profiles';

/** Формы публикации так, как их отдаёт `codec-policy.ts`. */
const av1: PublishShape = { codec: 'av1', scalabilityMode: 'L1T3', simulcast: false, backup: 'h264' };
const vp9: PublishShape = { codec: 'vp9', scalabilityMode: 'L1T3', simulcast: false, backup: 'h264' };
const h264: PublishShape = { codec: 'h264', simulcast: false, backup: 'vp8' };
const vp8: PublishShape = { codec: 'vp8', simulcast: false, backup: false };

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
    const options = screenOptions({ resolution: 1440, fps: 60 }, av1);
    expect(options.screenShareEncoding?.maxBitrate).toBe(16000000);
    expect(options.screenShareEncoding?.maxFramerate).toBe(60);
    expect(options.screenShareEncoding?.priority).toBe('high');
    expect(options.backupCodec).toEqual({ codec: 'h264' });
    // Запасной — рядом, а не вместо: один зритель без AV1 не переводит комнату на H.264 (Р-47).
    expect(options.backupCodecPolicy).toBe(BackupCodecPolicy.SIMULCAST);
    expect(options.simulcast).toBe(false);
    expect(options.screenShareSimulcastLayers).toBeUndefined();
    expect(options.degradationPreference).toBe('maintain-resolution');
    expect(options.scalabilityMode).toBe('L1T3');
    expect(screenHint).toBe('detail');
  });

  it('режим «чёткость» платит полосой за кадр, а не за частоту; «плавность» — за частоту (R95)', () => {
    expect(targetBitrate({ resolution: 1080, fps: 60, mode: 'sharp' })).toBe(4000000);
    expect(targetBitrate({ resolution: 1080, fps: 15, mode: 'sharp' })).toBe(4000000);
    expect(targetBitrate({ resolution: 1440, fps: 30, mode: 'sharp' })).toBe(6000000);
    expect(targetBitrate({ resolution: 1080, fps: 60, mode: 'smooth' })).toBe(10000000);
    expect(targetBitrate({ resolution: 1080, fps: 60 })).toBe(10000000);
    expect(modeOf({ mode: undefined })).toBe('smooth');
    expect(modeOf({ mode: 'sharp' })).toBe('sharp');
    // Оба режима — screencast и без понижения разрешения: разница только в полосе и кодеке.
    for (const mode of ['sharp', 'smooth'] as const) {
      const options = screenOptions({ resolution: 1080, fps: 30, mode }, vp9);
      expect(options.degradationPreference).toBe('maintain-resolution');
      expect(options.simulcast).toBe(false);
    }
    expect(
      screenOptions({ resolution: 1080, fps: 30, mode: 'sharp' }, vp9).screenShareEncoding?.maxBitrate,
    ).toBe(4000000);
  });

  it('захват просит выбранный кадр как ideal и частоту как потолок', () => {
    expect(captureConstraints({ resolution: 1440, fps: 60 })).toEqual({
      width: { ideal: 2560 },
      height: { ideal: 1440 },
      frameRate: { ideal: 60, max: 60 },
    });
  });

  it('у H.264 и VP8 временных слоёв не просит, но и разрешение не трогает', () => {
    for (const shape of [h264, vp8]) {
      const options = screenOptions({ resolution: 1080, fps: 30 }, shape);
      expect(options.scalabilityMode).toBeUndefined();
      expect(options.simulcast).toBe(false);
      expect(options.degradationPreference).toBe('maintain-resolution');
    }
    // У H.264 запасной — VP8 для зрителя без H.264; у VP8 запасного нет.
    expect(screenOptions({ resolution: 1080, fps: 30 }, h264).backupCodec).toEqual({ codec: 'vp8' });
    expect(screenOptions({ resolution: 1080, fps: 30 }, vp8).backupCodec).toBe(false);
    expect(screenOptions({ resolution: 1080, fps: 30 }, vp8).backupCodecPolicy).toBeUndefined();
  });

  /**
   * Подпорок у камеры нет: с ними слой выбирал сервер, и портрет телефона уходил компьютеру
   * подпоркой 360p на 15 кадров при выставленных 720p30.
   */
  it('камера отдаёт один слой — выбранный, временные слои только у VP9/AV1', () => {
    const camera = cameraOptions({ resolution: 1080, fps: 60 }, h264);
    expect(camera.simulcast).toBe(false);
    expect(camera.videoSimulcastLayers).toBeUndefined();
    expect(camera.scalabilityMode).toBeUndefined();
    expect(camera.videoEncoding).toEqual({ maxBitrate: 10000000, maxFramerate: 60 });
    const svc = cameraOptions({ resolution: 720, fps: 30 }, vp9);
    expect(svc.scalabilityMode).toBe('L1T3');
    expect(svc.backupCodec).toEqual({ codec: 'h264' });
    expect(svc.backupCodecPolicy).toBe(BackupCodecPolicy.SIMULCAST);
  });

  it('слои — ровно те, что решила политика: simulcast клиента Windows, K-SVC только программному (Р-47)', () => {
    const layered = cameraOptions({ resolution: 720, fps: 30 }, { ...h264, simulcast: true });
    expect(layered.simulcast).toBe(true);
    expect(layered.scalabilityMode).toBeUndefined();
    const ksvc = cameraOptions({ resolution: 720, fps: 30 }, { ...vp9, scalabilityMode: 'L3T3_KEY' });
    expect(ksvc).toMatchObject({ scalabilityMode: 'L3T3_KEY', simulcast: false });
    const rid = screenOptions({ resolution: 1080, fps: 60 }, { ...av1, simulcast: true });
    expect(rid).toMatchObject({ scalabilityMode: 'L1T3', simulcast: true });
    expect(
      cameraOptions({ resolution: 720, fps: 30 }, { codec: 'h265', simulcast: false, backup: 'h264' }),
    ).toMatchObject({ videoCodec: 'h265', simulcast: false, backupCodec: { codec: 'h264' } });
  });

  it('уровень для вопроса кодировщику — тот, что пойдёт в сеть', () => {
    expect(policyLevel('camera', { resolution: 480, fps: 30 })).toEqual({
      width: 854,
      height: 480,
      fps: 30,
      bitrate: 1200000,
    });
    expect(policyLevel('screen', { resolution: 1080, fps: 60, mode: 'sharp' })).toEqual({
      width: 1920,
      height: 1080,
      fps: 60,
      bitrate: 4000000,
    });
    // У камеры режима показа нет: «чёткость», оставшаяся в записи, полосу камеры не меняет.
    expect(policyLevel('camera', { resolution: 720, fps: 30, mode: 'sharp' }).bitrate).toBe(3000000);
    expect(policySourceOf('screen', { mode: 'sharp' })).toBe('screen-sharp');
    expect(policySourceOf('screen', {})).toBe('screen-smooth');
    expect(policySourceOf('camera', { mode: 'sharp' })).toBe('camera');
  });

  /** «Авто» нет: любой уровень — выбранный, и держит размер кадра, а не торгуется им. */
  it('публикует выбранное сразу и держит кадр у экрана и у камеры', () => {
    const screen = screenOptions({ resolution: 720, fps: 30 }, vp8);
    expect(screen.screenShareEncoding).toMatchObject({ maxBitrate: 3000000, maxFramerate: 30 });
    expect(screen.degradationPreference).toBe('maintain-resolution');
    const camera = cameraOptions({ resolution: 720, fps: 30 });
    expect(camera.videoEncoding).toEqual({ maxBitrate: 3000000, maxFramerate: 30 });
    expect(camera.degradationPreference).toBe('maintain-resolution');
    expect(camera.simulcast).toBe(false);
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

describe('cameraCapture — зум (R36)', () => {
  const pointer = (coarse: boolean) =>
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: coarse && query === '(pointer: coarse)' }));
  afterEach(() => vi.unstubAllGlobals());
  const profile = { resolution: 720, fps: 30 } as Parameters<typeof cameraCapture>[0];

  it('у телефона просит зум: без просьбы Chromium на Android его не отдаёт', () => {
    pointer(true);
    expect(cameraCapture(profile)).toMatchObject({ zoom: true });
  });

  it('у компьютера не просит: у PTZ-камеры это отдельный вопрос о разрешении', () => {
    pointer(false);
    expect(cameraCapture(profile)).not.toHaveProperty('zoom');
  });
});
