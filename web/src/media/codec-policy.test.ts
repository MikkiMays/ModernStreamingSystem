import { describe, expect, it } from 'vitest';
import {
  decideCodec,
  nvidiaOnly,
  probeKey,
  probeQueries,
  rungKey,
  sameShape,
  svcSimulcastServer,
  type Codec,
  type FailReason,
  type GpuHint,
  type PolicyInput,
  type ProbeAnswers,
  type Scalability,
} from './codec-policy';

type Answer = 'hw' | 'sw' | 'no';
/** Ответы кодировщика: `['av1', 'L1T3', 'hw']` — поддержан, плавно, в железе. */
function probe(...entries: [Codec, Scalability, Answer][]): ProbeAnswers {
  return Object.fromEntries(
    entries.map(([codec, mode, kind]) => [
      probeKey(codec, mode),
      { supported: kind !== 'no', smooth: kind !== 'no', powerEfficient: kind === 'hw' },
    ]),
  );
}
const level720 = { width: 1280, height: 720, fps: 30, bitrate: 3_000_000 };
const level1080x60 = { width: 1920, height: 1080, fps: 60, bitrate: 10_000_000 };
const level1080x30 = { width: 1920, height: 1080, fps: 30, bitrate: 4_000_000 };
const gpu = (...vendors: GpuHint['vendors'][number][]): GpuHint => ({ vendors, source: 'shell' });
/** Chromium на Windows декодирует всё; Firefox — без H.265; Safari без A17/M3 — без AV1. */
const chrome: Codec[] = ['av1', 'h265', 'vp9', 'h264', 'vp8'];
const firefox: Codec[] = ['av1', 'vp9', 'h264', 'vp8'];
const safari: Codec[] = ['h265', 'vp9', 'h264', 'vp8'];

/** Что отвечает Chromium на машине: программные кодеки есть всегда, аппаратные — по железу. */
const software = probe(
  ['av1', 'L1T3', 'sw'],
  ['av1', 'L1T1', 'sw'],
  ['vp9', 'L1T3', 'sw'],
  ['vp9', 'L1T1', 'sw'],
  ['vp9', 'L3T3_KEY', 'sw'],
  ['h264', 'L1T1', 'sw'],
);
/** RTX 30: NVENC H.264/H.265, без AV1. `encodingInfo` честно не знает про ловушку CB. */
const rtx30 = { ...software, ...probe(['h265', 'L1T1', 'hw'], ['h264', 'L1T1', 'hw']) };
/** RTX 40 с `WebRtcAV1HWEncode`: ещё и AV1 в железе с временными слоями. */
const rtx40 = { ...rtx30, ...probe(['av1', 'L1T3', 'hw'], ['av1', 'L1T1', 'hw']) };
/** Intel UHD: VP9 и H.264 в железе (L1T1–L1T3), H.265 этой сборке не отдан. */
const intel = { ...software, ...probe(['vp9', 'L1T3', 'hw'], ['vp9', 'L1T1', 'hw'], ['h264', 'L1T1', 'hw']) };
/** RDNA2: H.264/H.265 в железе, честные — без ловушки NVIDIA. */
const amd = { ...software, ...probe(['h265', 'L1T1', 'hw'], ['h264', 'L1T1', 'hw']) };

const input = (patch: Partial<PolicyInput>): PolicyInput => ({
  source: 'camera',
  platform: 'electron',
  level: level720,
  probe: software,
  cores: 8,
  sendable: ['av1', 'h265', 'vp9', 'h264', 'vp8'],
  ...patch,
});

describe('лестница камеры ПК', () => {
  it('NVIDIA без AV1 — H.265 в железе, с H.264 рядом про запас, без регрессии комнаты', () => {
    const decision = decideCodec(input({ probe: rtx30, gpu: gpu('nvidia') }));
    expect(decision).toMatchObject({ codec: 'h265', hw: true, simulcast: false, backup: 'h264' });
    expect(decision.scalabilityMode).toBeUndefined();
    expect(decision.reason).toBe('hardware');
    expect(decision.backupActive).toBe(false);
    // AV1 пропущен потому, что он не в железе, а не потому, что его нет вовсе.
    expect(decision.skipped[0]).toEqual({ codec: 'av1', hw: true, why: 'not-hardware' });
  });

  it('RTX 40 с ключом оболочки — AV1 в железе, L1T3', () => {
    const decision = decideCodec(input({ probe: rtx40, gpu: { ...gpu('nvidia'), av1hw: true } }));
    expect(decision).toMatchObject({ codec: 'av1', hw: true, scalabilityMode: 'L1T3', backup: 'h264' });
    // SFU 1.13.6 VP9/AV1 по rid не раскладывает — один поток SVC, как его и опубликует LiveKit.
    expect(decision.simulcast).toBe(false);
    expect(decideCodec(input({ probe: rtx40, svcSimulcast: true })).simulcast).toBe(true);
  });

  it('Intel — VP9 в железе; K-SVC в железе не просим', () => {
    const decision = decideCodec(input({ probe: intel, gpu: gpu('intel') }));
    expect(decision).toMatchObject({ codec: 'vp9', hw: true, scalabilityMode: 'L1T3', simulcast: false });
  });

  it('AMD — H.265; H.264 у AMD честный и годится вторым кодировщиком', () => {
    expect(decideCodec(input({ probe: amd, gpu: gpu('amd') })).codec).toBe('h265');
  });

  it('H.264 в железе на одной NVIDIA не аппаратный (CB → OpenH264), со встроенной Intel — аппаратный', () => {
    const onlyH264 = { ...probe(['h264', 'L1T1', 'hw']) };
    const nvidia = decideCodec(input({ probe: onlyH264, gpu: gpu('nvidia') }));
    expect(nvidia).toMatchObject({ codec: 'h264', hw: false, simulcast: false });
    expect(nvidia.skipped).toContainEqual({ codec: 'h264', hw: true, why: 'gpu' });
    const hybrid = decideCodec(input({ probe: onlyH264, gpu: gpu('nvidia', 'intel') }));
    expect(hybrid).toMatchObject({ codec: 'h264', hw: true, simulcast: true, backup: 'vp8' });
    expect(nvidiaOnly(gpu('nvidia'))).toBe(true);
    expect(nvidiaOnly(gpu('nvidia', 'amd'))).toBe(false);
    expect(nvidiaOnly(null)).toBe(false);
  });

  it('VP9 программно — только до 720p30 и при запасе ядер; выше — H.264, без понижения кадра', () => {
    expect(decideCodec(input({ cores: 4 }))).toMatchObject({
      codec: 'vp9',
      hw: false,
      scalabilityMode: 'L1T3',
    });
    const big = decideCodec(input({ level: level1080x30 }));
    expect(big).toMatchObject({ codec: 'h264', hw: false });
    expect(big.skipped).toContainEqual({ codec: 'vp9', hw: false, why: 'level' });
    const weak = decideCodec(input({ cores: 2 }));
    expect(weak.codec).toBe('h264');
    expect(weak.skipped).toContainEqual({ codec: 'vp9', hw: false, why: 'cpu' });
    expect(decideCodec(input({ health: { cpuTight: true } })).codec).toBe('h264');
  });

  it('K-SVC — только когда кодирует и так процессор и ядер восемь и больше, и только в клиенте Windows', () => {
    expect(decideCodec(input({ cores: 8 })).scalabilityMode).toBe('L3T3_KEY');
    expect(decideCodec(input({ cores: 6 })).scalabilityMode).toBe('L1T3');
    expect(decideCodec(input({ cores: 16, platform: 'desktop' })).scalabilityMode).toBe('L1T3');
  });

  it('программный H.264 — последняя ступень, когда в железе нет ничего', () => {
    const decision = decideCodec(input({ probe: probe(['h264', 'L1T1', 'sw']), cores: 2 }));
    expect(decision).toMatchObject({ codec: 'h264', hw: false, reason: 'software', simulcast: false });
  });
});

describe('показ', () => {
  it('«Плавность»: AV1 → H.265 → H.264 в железе; VP9 сюда не входит', () => {
    const smooth = (probeAnswers: ProbeAnswers, vendors = gpu('nvidia')) =>
      decideCodec(input({ source: 'screen-smooth', level: level1080x60, probe: probeAnswers, gpu: vendors }));
    expect(smooth(rtx40).codec).toBe('av1');
    expect(smooth(rtx40).scalabilityMode).toBe('L1T3');
    expect(smooth(rtx30).codec).toBe('h265');
    expect(smooth(intel, gpu('intel'))).toMatchObject({ codec: 'h264', hw: true, simulcast: true });
  });

  it('«Чёткость»: AV1/VP9 в железе первыми, программно — до 1080p30, потом H.265/H.264', () => {
    const sharp = (probeAnswers: ProbeAnswers, level = level1080x30, cores = 8) =>
      decideCodec(input({ source: 'screen-sharp', level, probe: probeAnswers, gpu: gpu('nvidia'), cores }));
    expect(sharp(intel).codec).toBe('vp9');
    expect(sharp(rtx30)).toMatchObject({ codec: 'av1', hw: false, scalabilityMode: 'L1T3' });
    expect(sharp(rtx30, level1080x60).codec).toBe('h265');
    expect(sharp(rtx30, level1080x30, 4).codec).toBe('h265');
  });

  it('у показа VP9/AV1 — только L1T3: аппаратный L1T1 не годится, LiveKit всё равно поставит L1T3', () => {
    const onlySingle = { ...rtx30, ...probe(['av1', 'L1T1', 'hw']) };
    const screen = decideCodec(input({ source: 'screen-smooth', level: level1080x60, probe: onlySingle }));
    expect(screen.codec).toBe('h265');
    // А камере аппаратный AV1 без временных слоёв лучше H.265.
    const camera = decideCodec(input({ probe: onlySingle }));
    expect(camera).toMatchObject({ codec: 'av1', scalabilityMode: 'L1T1', hw: true });
  });
});

describe('зрители', () => {
  it('зритель без H.265 — H.265 остаётся, H.264 идёт рядом для него (SIMULCAST), если железо тянет', () => {
    const decision = decideCodec(input({ probe: amd, gpu: gpu('amd'), viewers: [chrome, firefox] }));
    expect(decision).toMatchObject({ codec: 'h265', backup: 'h264', backupActive: true, reason: 'hardware' });
  });

  it('без запаса на второй кодировщик — следующая ступень, которую декодируют все', () => {
    const decision = decideCodec(
      input({ probe: amd, gpu: gpu('amd'), viewers: [chrome, firefox], health: { cpuTight: true } }),
    );
    expect(decision.codec).toBe('h264');
    expect(decision.reason).toBe('viewers');
    expect(decision.skipped).toContainEqual({ codec: 'h265', hw: true, why: 'viewers' });
  });

  it('Safari без AV1 не тянет всю комнату на H.264', () => {
    const publisher = { probe: rtx40, gpu: gpu('nvidia', 'intel') };
    const roomy = decideCodec(input({ ...publisher, viewers: [chrome, safari, chrome] }));
    expect(roomy).toMatchObject({ codec: 'av1', backup: 'h264', backupActive: true });
    // Нет запаса — H.265, который Safari декодирует, а не H.264.
    const tight = decideCodec(input({ ...publisher, viewers: [chrome, safari], health: { cpuTight: true } }));
    expect(tight.codec).toBe('h265');
  });

  it('у программной копии — только камера до 720p30 и восемь ядер; телефон второй кодировщик не держит', () => {
    const nvidia = { probe: rtx30, gpu: gpu('nvidia') };
    expect(decideCodec(input({ ...nvidia, viewers: [firefox] })).backupActive).toBe(true);
    expect(decideCodec(input({ ...nvidia, viewers: [firefox], cores: 4 })).codec).toBe('vp9');
    const phone = decideCodec(
      input({ platform: 'mobile', probe: probe(['vp9', 'L1T3', 'hw']), viewers: [['h264', 'vp8']] }),
    );
    expect(phone.codec).toBe('vp8');
  });

  it('кто ещё не сообщил, что декодирует, ступень не роняет — его прикроет запасной кодек', () => {
    const decision = decideCodec(input({ probe: rtx40, viewers: [null, chrome] }));
    expect(decision).toMatchObject({ codec: 'av1', backupActive: false });
  });

  it('на последней ступени зритель без кодека ничего не меняет', () => {
    const decision = decideCodec(
      input({ probe: probe(['h264', 'L1T1', 'sw']), cores: 2, viewers: [['vp8']] }),
    );
    expect(decision.codec).toBe('h264');
    expect(decision.backup).toBe('vp8');
  });
});

describe('телефон и Telegram', () => {
  it('один слой: H.264 в железе → VP9 в железе → VP8', () => {
    for (const platform of ['mobile', 'telegram'] as const) {
      const h264 = decideCodec(
        input({ platform, probe: probe(['h264', 'L1T1', 'hw'], ['vp9', 'L1T3', 'hw']) }),
      );
      expect(h264).toMatchObject({ codec: 'h264', simulcast: false, hw: true });
      const vp9 = decideCodec(
        input({ platform, probe: probe(['h264', 'L1T1', 'sw'], ['vp9', 'L1T3', 'hw']) }),
      );
      expect(vp9).toMatchObject({ codec: 'vp9', scalabilityMode: 'L1T3', simulcast: false });
      const vp8 = decideCodec(input({ platform, probe: probe(['h264', 'L1T1', 'sw']) }));
      expect(vp8).toMatchObject({ codec: 'vp8', simulcast: false, backup: false });
    }
  });

  it('браузер ПК тоже одним слоем (Р-32), даже с аппаратным H.264', () => {
    expect(decideCodec(input({ platform: 'desktop', probe: intel, gpu: gpu('intel') })).simulcast).toBe(
      false,
    );
    expect(
      decideCodec(input({ platform: 'desktop', source: 'screen-smooth', level: level1080x60, probe: intel })),
    ).toMatchObject({ codec: 'h264', simulcast: false });
  });
});

describe('сторож и вопросы кодировщику', () => {
  it('отвергнутая ступень пропускается; аппаратный упёрся в процессор — программный того же кодека тоже', () => {
    const failed = (entries: [string, FailReason][]) => ({ failed: new Map(entries) });
    const av1 = decideCodec(input({ probe: rtx40, health: failed([[rungKey('av1', true), 'software']]) }));
    expect(av1).toMatchObject({ codec: 'h265', reason: 'fallback' });
    expect(
      decideCodec(input({ probe: intel, health: failed([[rungKey('vp9', true), 'cpu']]) })),
    ).toMatchObject({
      codec: 'h264',
      hw: true,
    });
    const vp9Only = { ...software, ...probe(['vp9', 'L1T3', 'hw']) };
    const vp9 = decideCodec(input({ probe: vp9Only, health: failed([[rungKey('vp9', true), 'cpu']]) }));
    expect(vp9).toMatchObject({ codec: 'h264', hw: false });
    expect(vp9.skipped).toContainEqual({ codec: 'vp9', hw: false, why: 'failed' });
    // «Аппаратный» оказался программным — программная ступень того же кодека честная.
    const soft = decideCodec(input({ probe: vp9Only, health: failed([[rungKey('vp9', true), 'software']]) }));
    expect(soft).toMatchObject({ codec: 'vp9', hw: false });
  });

  it('публикуется ровно тот режим слоёв, о котором спросили кодировщик', () => {
    const cases: Partial<PolicyInput>[] = [
      { probe: rtx40 },
      { probe: intel },
      { probe: { ...rtx30, ...probe(['av1', 'L1T1', 'hw']) } },
      { probe: software, cores: 8 },
      { probe: software, cores: 4 },
      { source: 'screen-sharp', level: level1080x30, probe: rtx30 },
      { source: 'screen-smooth', level: level1080x60, probe: rtx40 },
      { platform: 'mobile', probe: probe(['vp9', 'L1T3', 'hw']) },
    ];
    for (const patch of cases) {
      const full = input(patch);
      const decision = decideCodec(full);
      const mode = decision.scalabilityMode ?? 'L1T1';
      const asked = probeQueries(full).map((q) => probeKey(q.codec, q.mode));
      expect(asked).toContain(probeKey(decision.codec, mode));
      const answer = full.probe[probeKey(decision.codec, mode)];
      expect(answer?.supported).toBe(true);
      if (decision.hw) expect(answer?.powerEfficient).toBe(true);
    }
    // Вопросы — про каждую ступень, с K-SVC у камеры клиента Windows и с H.264 для запасного.
    const asked = probeQueries({ source: 'camera', platform: 'electron' }).map((q) =>
      probeKey(q.codec, q.mode),
    );
    expect(asked).toEqual(
      expect.arrayContaining(['av1/L1T3', 'av1/L1T1', 'h265/L1T1', 'vp9/L1T3', 'vp9/L3T3_KEY', 'h264/L1T1']),
    );
    const screen = probeQueries({ source: 'screen-smooth', platform: 'electron' }).map((q) => q.mode);
    expect(screen).not.toContain('L3T3_KEY');
  });

  it('без ответов кодировщика — H.264, если браузер его отдаёт, иначе VP8', () => {
    expect(decideCodec(input({ probe: {} }))).toMatchObject({ codec: 'h264', reason: 'baseline' });
    expect(decideCodec(input({ platform: 'mobile', probe: {} })).codec).toBe('h264');
    expect(decideCodec(input({ probe: {}, sendable: ['vp8', 'vp9'] })).codec).toBe('vp8');
  });

  it('запасной: у VP9/AV1/H.265 — H.264, у H.264 — VP8, у VP8 нет', () => {
    expect(decideCodec(input({ probe: rtx40 })).backup).toBe('h264');
    expect(decideCodec(input({ probe: rtx40, sendable: ['av1', 'vp8'] })).backup).toBe('vp8');
    expect(decideCodec(input({ probe: probe(['h264', 'L1T1', 'sw']), cores: 1 })).backup).toBe('vp8');
  });

  it('смена формы — только когда меняется то, что уходит в сеть', () => {
    const a = decideCodec(input({ probe: rtx40 }));
    const b = decideCodec(input({ probe: rtx40, viewers: [safari], gpu: gpu('nvidia', 'intel') }));
    expect(b.backupActive).toBe(true);
    expect(sameShape(a, b)).toBe(true);
    expect(sameShape(a, decideCodec(input({ probe: rtx30 })))).toBe(false);
  });

  it('VP9/AV1 по rid SFU раскладывает только новее 1.13.6', () => {
    expect(svcSimulcastServer('1.13.6')).toBe(false);
    expect(svcSimulcastServer('1.13.7')).toBe(true);
    expect(svcSimulcastServer('1.14.0')).toBe(true);
    expect(svcSimulcastServer('2.0.0')).toBe(true);
    expect(svcSimulcastServer('1.9.12')).toBe(false);
    expect(svcSimulcastServer(undefined)).toBe(false);
  });
});
