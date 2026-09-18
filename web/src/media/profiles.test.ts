import { describe, expect, it } from 'vitest';
import {
  cameraOptions,
  captureCeiling,
  companionCameraCapture,
  companionCameraOptions,
  fitSource,
  forcedCameraConstraints,
  screenOptions,
} from './profiles';

describe('screen profiles', () => {
  it('preserves portrait, ultrawide and conventional source geometry', () => {
    expect(fitSource(1080, 1920, 720)).toEqual({ width: 720, height: 1280 });
    expect(fitSource(5120, 1440, 1440)).toEqual({ width: 2560, height: 720 });
    expect(fitSource(3840, 2160, 1440)).toEqual({ width: 2560, height: 1440 });
    expect(fitSource(640, 480, 1080)).toEqual({ width: 640, height: 480 });
  });
  /**
   * Выбранный уровень — это верхний слой, а не единственный. Слои под ним ничего у него не
   * отнимают: кто тянет, тот получает верхний, а кто не тянет — мелкий вместо замершей
   * картинки. Раньше здесь стояло `simulcast: false`, и второму не доставалось ничего.
   */
  it('отдаёт выбранный уровень верхним слоем и оставляет подпорки для тех, кто не тянет', () => {
    const options = screenOptions({ resolution: 1440, fps: 60, automatic: false }, 'av1');
    expect(options.screenShareEncoding?.maxBitrate).toBe(16000000);
    expect(options.screenShareEncoding?.maxFramerate).toBe(60);
    expect(options.backupCodec).toEqual({ codec: 'vp8' });
    expect(options.simulcast).toBe(true);
    expect(options.degradationPreference).toBe('maintain-framerate');
    const layers = options.screenShareSimulcastLayers ?? [];
    expect(layers.length).toBeGreaterThan(0);
    // Подпорки обязаны быть мельче выбранного и заметно дешевле его самого.
    for (const layer of layers) expect(layer.height).toBeLessThan(1440);
    expect(layers.reduce((sum, layer) => sum + layer.encoding.maxBitrate, 0)).toBeLessThan(
      options.screenShareEncoding!.maxBitrate! / 5,
    );
  });

  /**
   * Между выбранным уровнем и подпоркой не должно быть пропасти: приёмник выбирает слой под
   * размер плитки и падает на её дно. С парой 1080p/360p плитка в семьсот пикселей получала
   * 360p — вдвое меньше того, что в неё влезает. «Авто» бережёт канал и остаётся мельче.
   */
  it('под выбранный вручную уровень кладёт ступень 720p, а под «Авто» — дешёвые слои', () => {
    const screen = screenOptions({ resolution: 1440, fps: 60, automatic: false }, 'vp8');
    expect(screen.screenShareSimulcastLayers?.map((layer) => layer.height)).toEqual([360, 720]);
    const camera = cameraOptions({ resolution: 1440, fps: 60, automatic: false });
    expect(camera.videoSimulcastLayers?.map((layer) => layer.height)).toEqual([360, 720]);
    const auto = cameraOptions({ resolution: 1440, fps: 60, automatic: true });
    expect(auto.videoSimulcastLayers?.map((layer) => layer.height)).toEqual([180, 360]);
  });

  it('под 720p не подкладывает слой почти того же размера', () => {
    const layers = screenOptions(
      { resolution: 720, fps: 30, automatic: false },
      'vp8',
    ).screenShareSimulcastLayers;
    expect(layers?.map((layer) => layer.height)).toEqual([360]);
  });
  it('keeps the smaller layers when quality is automatic', () => {
    const options = screenOptions({ resolution: 1080, fps: 30, automatic: true }, 'vp8');
    expect(options.simulcast).toBe(true);
    expect(options.screenShareSimulcastLayers?.length).toBeGreaterThan(0);
    expect(options.degradationPreference).toBe('balanced');
  });
  it('applies the same rule to the camera', () => {
    const chosen = cameraOptions({ resolution: 1080, fps: 60, automatic: false });
    expect(chosen.simulcast).toBe(true);
    expect(chosen.videoEncoding?.maxFramerate).toBe(60);
    expect(chosen.degradationPreference).toBe('maintain-framerate');
    expect(cameraOptions({ resolution: 1080, fps: 60, automatic: true }).simulcast).toBe(true);
  });

  /**
   * Частоту нельзя задать сверху: и `maxFramerate`, и битрейт только ограничивают. Камера,
   * которая в полумраке удлиняет выдержку, укладывается в любой такой предел — и отдаёт
   * двадцать кадров там, где просили тридцать. Нижнюю границу задаёт только `min`.
   */
  it('выбранную вручную частоту требует, а автоматическую — нет', () => {
    const asked = forcedCameraConstraints({ resolution: 1080, fps: 60, automatic: false });
    expect(asked[0]).toEqual({
      width: { min: 1920, ideal: 1920 },
      height: { min: 1080, ideal: 1080 },
      frameRate: { min: 60, ideal: 60 },
    });
    expect(forcedCameraConstraints({ resolution: 1080, fps: 60, automatic: true })).toEqual([]);
  });

  /**
   * Камера, умеющая 60 кадров только в 720p, обязана отдать выбранные 1080p, а не подменить
   * их частотой: «Качество» в списке стоит выше «Плавности», и жёстким остаётся именно кадр.
   */
  it('уступает частотой, а не размером кадра', () => {
    const asked = forcedCameraConstraints({ resolution: 1080, fps: 60, automatic: false });
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
    const modest = forcedCameraConstraints({ resolution: 1440, fps: 60, automatic: false }, {
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

  /** Захват в «Авто» идёт по верху лестницы: под текущую ступень подняться было бы некуда. */
  it('просит у источника потолок, а не текущую ступень', () => {
    expect(captureCeiling({ resolution: 720, fps: 15, automatic: true })).toEqual({
      resolution: 1440,
      fps: 60,
    });
    expect(captureCeiling({ resolution: 1080, fps: 30, automatic: false })).toEqual({
      resolution: 1080,
      fps: 30,
      automatic: false,
    });
  });
  it('камера рядом с показом идёт одним слоем и заметно дешевле самой скромной обычной', () => {
    const companion = companionCameraOptions();
    const smallest = cameraOptions({ resolution: 720, fps: 15, automatic: true });
    expect(companion.simulcast).toBe(false);
    expect(companion.videoSimulcastLayers).toBeUndefined();
    expect(companion.videoEncoding!.maxBitrate).toBeLessThan(smallest.videoEncoding!.maxBitrate!);
    expect(companionCameraCapture().resolution.height).toBe(360);
  });
});
