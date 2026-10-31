/**
 * Политика кодеков отдачи (R152, Р-47): каким кодеком и какими слоями публиковать камеру и показ.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ЧИСТЫЙ МОДУЛЬ. На игровом ПК по LAN 500 Мбит/с уходил H.264 — не сбоем, а
 * правилами: «Плавность» ставила H.264 первым, камере нужен был аппаратный VP9 (у NVIDIA и AMD его
 * нет), аппаратный AV1 для WebRTC в Chromium на Windows выключен, K-SVC `L3T3_KEY` десктопа Media
 * Foundation не кодирует (уходило в libvpx → `cpu` → H.264), а запасной кодек LiveKit по умолчанию
 * (`PREFER_REGRESSION`) переводил всю комнату на H.264 из-за одного зрителя
 * (`backlog/release-1.1/ANALYSIS-MEDIA.md` §A). Решение — таблица здесь, без браузера и без SDK:
 * всё, что про машину, приходит входами, и каждая строчка лестницы проверяется тестом.
 *
 * ВХОДЫ.
 * 1. Платформа: клиент Windows (Electron), браузер ПК, телефон, Telegram.
 * 2. Ответы кодировщика: `mediaCapabilities.encodingInfo({type:'webrtc'})` спрошен с тем же
 *    `scalabilityMode`, размером, частотой и битрейтом, что пойдут в сеть (`probeQueries`), — иначе
 *    `powerEfficient` отвечает про другой поток (у Media Foundation нет пространственных слоёв).
 * 3. Подсказка о видеокарте — от оболочки (`app.gpu`) или WebGL. Нужна ради одной ловушки: SFU
 *    договаривает H.264 constrained baseline (`42e01f` первым), а Chromium для CB пропускает NVENC
 *    (crbug 1088650) — «аппаратный» H.264 на машине с одной NVIDIA на деле OpenH264.
 * 4. Что декодируют зрители (`decode-caps.ts`, поле участника в снимке ядра).
 * 5. Здоровье: что сторож отверг в этой сессии (`codec-planner.ts`), тесно ли процессору.
 *
 * ЧЕГО ЗДЕСЬ НЕТ — ПОЛОСЫ. Хороший канал ничего не понижает и плохой тоже (X10, Р-19): кодек
 * меняется, только пока кадр и частота остаются выбранными, а программная ступень не берётся выше
 * своего потолка (VP9 программно — до 720p30), чтобы смена кодека не стала скрытой деградацией.
 */

export type Codec = 'av1' | 'h265' | 'vp9' | 'h264' | 'vp8';
/** Порядок «лучше — раньше»: в нём же кодеки ходят по проводу (`decode-caps.ts`). */
export const CODECS: readonly Codec[] = ['av1', 'h265', 'vp9', 'h264', 'vp8'];
export const isCodec = (value: unknown): value is Codec => CODECS.includes(value as Codec);

/** Что публикуется: камера или показ в одном из двух режимов (R95). */
export type PolicySource = 'camera' | 'screen-smooth' | 'screen-sharp';
export type PolicyPlatform = 'electron' | 'desktop' | 'mobile' | 'telegram';
/** Режимы слоёв, которые публикует Cord. У H.264, H.265 и VP8 — всегда `L1T1`. */
export type Scalability = 'L1T1' | 'L1T3' | 'L3T3_KEY';
export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'qualcomm' | 'arm' | 'other';

/** Ответ `encodingInfo` на один вопрос. */
export interface ProbeAnswer {
  supported: boolean;
  smooth: boolean;
  powerEfficient: boolean;
}
/** Ответы по ключу `probeKey(codec, mode)` — все для одного уровня (кадр, частота, битрейт). */
export type ProbeAnswers = Readonly<Record<string, ProbeAnswer | undefined>>;
export const probeKey = (codec: Codec, mode: Scalability) => `${codec}/${mode}`;

/** Уровень, под который выбираем: короткая сторона кадра, частота и битрейт из `profiles.ts`. */
export interface PolicyLevel {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

export interface GpuHint {
  vendors: readonly GpuVendor[];
  /** Клиент Windows включил аппаратный AV1 для WebRTC (`WebRtcAV1HWEncode`, флаг `codec.av1hw`). */
  av1hw?: boolean;
  source: 'shell' | 'webgl';
}

/** Почему сторож отверг ступень: процессор, время кадра или «аппаратный» оказался программным. */
export type FailReason = 'cpu' | 'encode-time' | 'software';
/** Ключ ступени в памяти сторожа: `av1:hw`, `vp9:sw`. */
export const rungKey = (codec: Codec, hw: boolean) => `${codec}:${hw ? 'hw' : 'sw'}`;

export interface PolicyHealth {
  failed?: ReadonlyMap<string, FailReason>;
  /** Процессору тесно (Compute Pressure `serious`/`critical`): второй кодировщик не поднимать. */
  cpuTight?: boolean;
}

export interface PolicyInput {
  source: PolicySource;
  platform: PolicyPlatform;
  level: PolicyLevel;
  probe: ProbeAnswers;
  gpu?: GpuHint | null;
  /** Что декодирует каждый зритель; `null` — ещё не сообщил (его прикроет запасной кодек). */
  viewers?: readonly (readonly Codec[] | null)[];
  health?: PolicyHealth;
  /** `navigator.hardwareConcurrency`; нет — считаем, что запаса нет. */
  cores?: number;
  /** SFU раскладывает VP9/AV1 simulcast по rid (LiveKit новее 1.13.6, `svcSimulcastServer`). */
  svcSimulcast?: boolean;
  /** Кодеки, которые браузер вообще умеет отдавать (`RTCRtpSender.getCapabilities`). */
  sendable?: readonly Codec[];
}

/**
 * Почему выбран этот кодек — для «Диагностики» и журнала:
 * `hardware` — лучшая аппаратная ступень этой машины; `software` — аппаратных нет, кодирует процессор;
 * `viewers` — ступень выше пропущена, потому что её не декодирует зритель, а второй кодировщик не по
 * силам; `fallback` — ступень выше отверг сторож; `baseline` — ни одна ступень не подошла.
 */
export type ChoiceReason = 'hardware' | 'software' | 'viewers' | 'fallback' | 'baseline';
export type SkipReason = 'unsupported' | 'not-hardware' | 'level' | 'cpu' | 'gpu' | 'failed' | 'viewers';

export interface Skip {
  codec: Codec;
  hw: boolean;
  why: SkipReason;
}

/** Форма публикации — ровно то, что `profiles.ts` превращает в опции LiveKit. */
export interface PublishShape {
  codec: Codec;
  /** Только у VP9/AV1. */
  scalabilityMode?: Scalability;
  simulcast: boolean;
  /** Запасной кодек: идёт рядом (политика SIMULCAST), когда его попросит зритель, а не вместо. */
  backup: 'h264' | 'vp8' | false;
}

export interface CodecDecision extends PublishShape {
  source: PolicySource;
  /** Ждём ли аппаратный кодировщик: по нему сторож узнаёт «аппаратный стал программным». */
  hw: boolean;
  /** Есть зритель, которому нужен запасной кодек, и запас по железу это позволяет. */
  backupActive: boolean;
  reason: ChoiceReason;
  skipped: readonly Skip[];
}

/** VP8 одним слоем — то, что кодируется всегда. */
export const BASELINE: PublishShape = { codec: 'vp8', simulcast: false, backup: false };

interface Rung {
  codec: Codec;
  hw: boolean;
  /** Потолок уровня для программной ступени: выше неё процессор не вытянет — значит, и не берём. */
  max?: { height: number; fps: number };
  /** Сколько ядер нужно программной ступени (кроме последней). */
  cores?: number;
}

const hw = (codec: Codec): Rung => ({ codec, hw: true });
const sw = (codec: Codec, max?: Rung['max'], cores?: number): Rung => ({ codec, hw: false, max, cores });

/**
 * Лестницы — сверху вниз; аппаратные ступени, кроме явно программных (Р-47).
 *
 * Камера ПК: AV1 → H.265 → VP9 → H.264 в железе, затем VP9 программно до 720p30 при запасе ядер,
 * затем H.264 как есть. «Плавность»: AV1 → H.265 → H.264 в железе — 60 кадров программно не
 * вытянуть. «Чёткость»: AV1 и VP9 первыми (screen content coding: текст чище при той же полосе),
 * программно — до 1080p30, потом H.265/H.264 в железе. Телефон: H.264 → VP9 в железе → VP8.
 */
const DESKTOP: Record<PolicySource, readonly Rung[]> = {
  camera: [hw('av1'), hw('h265'), hw('vp9'), hw('h264'), sw('vp9', { height: 720, fps: 30 }, 4), sw('h264')],
  'screen-smooth': [hw('av1'), hw('h265'), hw('h264'), sw('h264')],
  'screen-sharp': [
    hw('av1'),
    hw('vp9'),
    sw('av1', { height: 1080, fps: 30 }, 8),
    sw('vp9', { height: 1080, fps: 30 }, 8),
    hw('h265'),
    hw('h264'),
    sw('h264'),
  ],
};
const MOBILE: readonly Rung[] = [hw('h264'), hw('vp9'), sw('vp8')];

const svc = (codec: Codec) => codec === 'vp9' || codec === 'av1';
const ladderOf = (input: Pick<PolicyInput, 'platform' | 'source'>) =>
  input.platform === 'mobile' || input.platform === 'telegram' ? MOBILE : DESKTOP[input.source];
/** Слоями (simulcast) публикует только клиент Windows: телефон и веб — одним слоем (Р-32). */
const layered = (input: Pick<PolicyInput, 'platform'>) => input.platform === 'electron';
/** K-SVC — только когда кодирует и так процессор и ему есть чем (Р-47 п. 5). */
const KSVC_CORES = 8;

/**
 * Какие режимы слоёв пробовать для ступени — в порядке предпочтения.
 *
 * Показ VP9/AV1 — только `L1T3`: LiveKit сам ставит показу `L1T3`, когда не раскладывает его по rid,
 * и опубликовать то, чего кодировщик в железе не умеет, значило бы молча уйти в libvpx. Камера —
 * `L1T3`, а если железо умеет только один слой — `L1T1`: аппаратный AV1 без временных слоёв лучше
 * программного. Программный VP9 камеры на ПК при восьми и больше ядрах — K-SVC `L3T3_KEY`.
 */
function modesFor(rung: Rung, input: Pick<PolicyInput, 'platform' | 'source' | 'cores' | 'health'>) {
  if (!svc(rung.codec)) return ['L1T1'] as const;
  if (input.source !== 'camera') return ['L1T3'] as const;
  if (!rung.hw && layered(input) && (input.cores ?? 0) >= KSVC_CORES && !input.health?.cpuTight)
    return ['L3T3_KEY', 'L1T3'] as const;
  return rung.hw ? (['L1T3', 'L1T1'] as const) : (['L1T3'] as const);
}

/**
 * Что спросить у кодировщика для этого источника и платформы — все ступени, все их режимы и H.264
 * для запасного кодека. Отвечать надо ровно на эти вопросы: решение берёт режим только из них.
 */
export function probeQueries(
  input: Pick<PolicyInput, 'platform' | 'source'> & { cores?: number },
): { codec: Codec; mode: Scalability }[] {
  const seen = new Set<string>();
  const queries: { codec: Codec; mode: Scalability }[] = [];
  const add = (codec: Codec, mode: Scalability) => {
    const key = probeKey(codec, mode);
    if (seen.has(key)) return;
    seen.add(key);
    queries.push({ codec, mode });
  };
  for (const rung of ladderOf(input)) {
    // Спрашиваем и K-SVC: ответ дешёвый, а нужен ли он, решат ядра и нагрузка в момент выбора.
    for (const mode of modesFor(rung, { ...input, cores: KSVC_CORES })) add(rung.codec, mode);
    for (const mode of modesFor(rung, { ...input, cores: 0 })) add(rung.codec, mode);
  }
  add('h264', 'L1T1');
  return queries;
}

/** Одна NVIDIA без встроенной Intel/AMD: H.264 CB уходит в OpenH264 (crbug 1088650). */
export function nvidiaOnly(gpu: GpuHint | null | undefined): boolean {
  if (!gpu?.vendors.length) return false;
  return gpu.vendors.includes('nvidia') && !gpu.vendors.some((v) => v === 'intel' || v === 'amd');
}

const answered = (answer: ProbeAnswer | undefined, needHw: boolean) =>
  !!answer && answer.supported && answer.smooth !== false && (!needHw || answer.powerEfficient);

/** Аппаратный H.264 для запасного кодека — по-настоящему аппаратный. */
function h264Hardware(input: PolicyInput): boolean {
  return (
    answered(input.probe[probeKey('h264', 'L1T1')], true) &&
    !nvidiaOnly(input.gpu) &&
    !input.health?.failed?.has(rungKey('h264', true))
  );
}

function sendable(input: PolicyInput, codec: Codec) {
  return (input.sendable ?? ['vp8', 'h264']).includes(codec);
}

function backupFor(codec: Codec, input: PolicyInput): PublishShape['backup'] {
  if (codec === 'vp8') return false;
  if (codec === 'h264') return 'vp8';
  return sendable(input, 'h264') ? 'h264' : 'vp8';
}

/**
 * Хватит ли железа на второй кодировщик рядом с основным — для зрителя, который основной не
 * декодирует. На телефоне — нет; при тесном процессоре — нет; аппаратный H.264 — да; программная
 * копия — только у камеры до 720p30 и при восьми ядрах.
 */
function backupHeadroom(input: PolicyInput, backup: PublishShape['backup']): boolean {
  if (!backup || input.platform === 'mobile' || input.platform === 'telegram') return false;
  if (input.health?.cpuTight) return false;
  if (backup === 'h264' && h264Hardware(input)) return true;
  return (
    input.source === 'camera' &&
    input.level.height <= 720 &&
    input.level.fps <= 30 &&
    (input.cores ?? 0) >= KSVC_CORES
  );
}

function rungFailed(rung: Rung, failed: ReadonlyMap<string, FailReason> | undefined): boolean {
  if (!failed) return false;
  if (failed.has(rungKey(rung.codec, rung.hw))) return true;
  // Аппаратный упёрся в процессор — программный того же кодека упрётся тем более.
  if (!rung.hw) {
    const hardware = failed.get(rungKey(rung.codec, true));
    return hardware === 'cpu' || hardware === 'encode-time';
  }
  return false;
}

/** Решение для одного источника. Чистая функция: одни и те же входы — одно и то же решение. */
export function decideCodec(input: PolicyInput): CodecDecision {
  const skipped: Skip[] = [];
  const ladder = ladderOf(input);
  // Ответов нет вовсе (`encodingInfo` без `webrtc`, старый Safari): вслепую лестницу не пройти —
  // H.264, который кодируется железом почти везде, иначе VP8. Так было и до политики.
  const blind = !Object.values(input.probe).some((answer) => answer !== undefined);
  for (const [index, rung] of blind ? [] : ladder.entries()) {
    const last = index === ladder.length - 1;
    const skip = (why: SkipReason) => skipped.push({ codec: rung.codec, hw: rung.hw, why });
    if (rungFailed(rung, input.health?.failed)) {
      skip('failed');
      continue;
    }
    if (rung.hw && rung.codec === 'h264' && nvidiaOnly(input.gpu)) {
      skip('gpu');
      continue;
    }
    if (rung.max && (input.level.height > rung.max.height || input.level.fps > rung.max.fps)) {
      skip('level');
      continue;
    }
    if (!last && !rung.hw && ((input.cores ?? 0) < (rung.cores ?? 0) || input.health?.cpuTight)) {
      skip('cpu');
      continue;
    }
    const mode = modesFor(rung, input).find((m) => answered(input.probe[probeKey(rung.codec, m)], rung.hw));
    if (!mode) {
      const any = modesFor(rung, input).some((m) => answered(input.probe[probeKey(rung.codec, m)], false));
      // Последняя программная ступень без ответа кодировщика — если браузер кодек всё же отдаёт.
      if (!(last && !rung.hw && sendable(input, rung.codec))) {
        skip(any ? 'not-hardware' : 'unsupported');
        continue;
      }
    }
    const backup = backupFor(rung.codec, input);
    const known = (input.viewers ?? []).filter((v): v is readonly Codec[] => v !== null);
    const lacking = known.some((v) => !v.includes(rung.codec));
    const headroom = lacking && backupHeadroom(input, backup);
    // Ниже — ступень, которую декодируют все: брать её, а не держать вторую копию на последней.
    if (lacking && !headroom && !last) {
      skip('viewers');
      continue;
    }
    const simulcast =
      layered(input) &&
      rung.hw &&
      (rung.codec === 'h264' || (svc(rung.codec) && !!input.svcSimulcast && mode !== 'L3T3_KEY'));
    return {
      source: input.source,
      codec: rung.codec,
      hw: rung.hw,
      ...(svc(rung.codec) ? { scalabilityMode: mode ?? 'L1T3' } : {}),
      simulcast,
      backup,
      backupActive: headroom,
      reason: reasonOf(skipped, rung.hw),
      skipped,
    };
  }
  const codec: Codec = sendable(input, 'h264') ? 'h264' : 'vp8';
  return {
    source: input.source,
    codec,
    hw: false,
    simulcast: false,
    backup: codec === 'h264' ? 'vp8' : false,
    backupActive: false,
    reason: 'baseline',
    skipped,
  };
}

function reasonOf(skipped: readonly Skip[], hardware: boolean): ChoiceReason {
  if (skipped.some((s) => s.why === 'failed')) return 'fallback';
  if (skipped.some((s) => s.why === 'viewers')) return 'viewers';
  return hardware ? 'hardware' : 'software';
}

/** Меняет ли новое решение то, что уходит в сеть (то есть нужна ли переопубликация). */
export function sameShape(a: PublishShape | undefined, b: PublishShape | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.codec === b.codec &&
    a.scalabilityMode === b.scalabilityMode &&
    a.simulcast === b.simulcast &&
    a.backup === b.backup
  );
}

/**
 * Раскладывает ли SFU VP9/AV1 simulcast по rid. livekit-client 2.22 считает, что LiveKit 1.13.6 и
 * старше — нет (`isSVCSimulcastSupportedByServer`), и тогда публикует один поток SVC: решение должно
 * говорить о том же, что уйдёт в сеть.
 */
export function svcSimulcastServer(version: string | undefined): boolean {
  if (!version) return false;
  const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [major = 0, minor = 0, patch = 0] = parts;
  return major > 1 || (major === 1 && (minor > 13 || (minor === 13 && patch > 6)));
}

/** MIME кодека в статистике и в `encodingInfo`. */
export const codecMime: Record<Codec, string> = {
  av1: 'video/AV1',
  h265: 'video/H265',
  vp9: 'video/VP9',
  h264: 'video/H264',
  vp8: 'video/VP8',
};
