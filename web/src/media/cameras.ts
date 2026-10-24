/**
 * Какие камеры человеку показывать, а какие — нет.
 *
 * ЗАЧЕМ. На телефоне до широкоугольной камеры было не добраться вовсе. Переворот при
 * известном `facingMode` меняет не устройство, а **ограничение**: браузер сам берёт линзу,
 * которую считает основной для этой стороны, и до второй не доходит никогда. А список
 * устройств по именам показывался только при мыши — то есть ровно там, где четырёх камер
 * не бывает.
 *
 * ПОЧЕМУ НЕ ПРОСТО СПИСОК. `enumerateDevices` на телефоне возвращает шесть-семь записей:
 * «camera2 0, facing back», «camera2 3, facing back», телефото, монохром, иногда виртуальные.
 * Список из семи непонятных имён хуже, чем две кнопки. Поэтому берём по стороне не больше
 * двух: основную и вторую, если она похожа на широкоугольную.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Надёжного способа отличить широкоугольную линзу от телефото: стандарт
 * такого поля не даёт, остаются только названия, а они у каждой платформы свои. Поэтому
 * «широкоугольная» пишется, когда это видно по названию, и «вторая» — когда не видно.
 * Соврать о том, чего не знаем, хуже, чем назвать вещь нейтрально.
 */

import type { Translate } from '../i18n';

export type CameraSide = 'user' | 'environment';

export interface CameraChoice {
  deviceId: string;
  /** Что показать человеку: «Фронтальная», «Основная», «Широкоугольная», «Вторая». */
  label: string;
  side: CameraSide;
  /** Первая линза стороны — та, которую браузер и так выбирает переворотом. */
  primary: boolean;
  /** Вторая линза названа широкоугольной самой платформой (по названию). */
  wide: boolean;
}

export interface CameraInput {
  deviceId: string;
  label: string;
  /** `getCapabilities().facingMode`, когда платформа его отдаёт. */
  facingMode?: string[];
}

const FRONT = /(front|user|фронт|selfie)/i;
const BACK = /(back|rear|environment|задн|тыл)/i;
const WIDE = /(ultra[\s-]?wide|wide[\s-]?angle|ultrawide|ширик|широкоуг)/i;
/** Телефото и прочая экзотика: показывать её рядом с двумя понятными кнопками незачем. */
const NARROW = /(tele|zoom|macro|depth|mono|ir\b|infrared)/i;

function sideOf(camera: CameraInput): CameraSide | null {
  // Возможности платформы старше названия: название — это то, что кто-то написал строкой.
  if (camera.facingMode?.includes('environment')) return 'environment';
  if (camera.facingMode?.includes('user')) return 'user';
  if (BACK.test(camera.label)) return 'environment';
  if (FRONT.test(camera.label)) return 'user';
  return null;
}

/**
 * Разложить камеры устройства на то, что стоит предлагать.
 *
 * @returns не больше четырёх записей: по две на сторону. Пустой список означает, что
 *   классифицировать нечего — обычно это настольная машина с одной камерой, где выбор
 *   и не нужен, либо имена ещё не выданы, потому что нет разрешения.
 */
export function classifyCameras(t: Translate, cameras: CameraInput[]): CameraChoice[] {
  const sides: Record<CameraSide, CameraInput[]> = { user: [], environment: [] };
  for (const camera of cameras) {
    if (!camera.deviceId) continue;
    const side = sideOf(camera);
    if (side) sides[side].push(camera);
  }
  // Ни одну сторону не удалось назвать — значит, это не телефон, и выбирать нечего.
  if (!sides.user.length && !sides.environment.length) return [];

  const choices: CameraChoice[] = [];
  for (const side of ['user', 'environment'] as const) {
    const list = sides[side];
    if (!list.length) continue;
    // Основная — первая, что не выглядит телефото: браузер по перевороту берёт именно такую.
    const ordered = [...list].sort((a, b) => Number(NARROW.test(a.label)) - Number(NARROW.test(b.label)));
    const [main, ...rest] = ordered;
    choices.push({
      deviceId: main!.deviceId,
      label: side === 'user' ? t(($) => $.devices.lens.front) : t(($) => $.devices.lens.main),
      side,
      primary: true,
      wide: false,
    });
    const second =
      rest.find((camera) => WIDE.test(camera.label)) ?? rest.find((camera) => !NARROW.test(camera.label));
    if (second)
      choices.push({
        deviceId: second.deviceId,
        label: WIDE.test(second.label)
          ? side === 'user'
            ? t(($) => $.devices.lens.frontWide)
            : t(($) => $.devices.lens.wide)
          : side === 'user'
            ? t(($) => $.devices.lens.secondFront)
            : t(($) => $.devices.lens.secondMain),
        side,
        primary: false,
        wide: WIDE.test(second.label),
      });
  }
  // Одна камера — это не выбор, а надпись. Показывать её списком незачем.
  return choices.length > 1 ? choices : [];
}

/** Кнопка переключателя линз на своей плитке (T21). */
export interface Lens {
  deviceId: string;
  /** Коротко, как в системной камере: «0.5×» и «1×», а для неизвестной второй линзы — «1» и «2». */
  short: string;
  /** Полностью — для диктора и подсказки: «Широкоугольная», «Основная». */
  label: string;
  active: boolean;
  /** Широкоугольная, названная так самой платформой: её и показывает «0.5×» зума (R36). */
  wide: boolean;
}

/**
 * Линзы той стороны, куда камера смотрит сейчас, — для переключателя «0.5× / 1×» на своей плитке.
 *
 * Переворот (фронтальная ↔ задняя) — кнопка в пульте; вторая линза той же стороны — здесь, на
 * самом кадре, как в системной камере телефона. Показывается, только когда на этой стороне две
 * линзы: одна линза — не выбор.
 *
 * Сторона берётся по устройству, а если браузер выбрал линзу сам (переворот меняет
 * `facingMode`, а не устройство) и её нет среди двух, — по `facingMode`; тогда горит основная:
 * браузер переворотом берёт именно её.
 *
 * @returns линзы слева направо (широкоугольная — первой, как «0.5×» в системной камере) или `null`.
 */
export function lensesFor(
  choices: CameraChoice[],
  current: { deviceId?: string; facingMode?: string },
): Lens[] | null {
  const matched = choices.find((choice) => choice.deviceId === current.deviceId);
  const side =
    matched?.side ??
    (current.facingMode === 'user' || current.facingMode === 'environment' ? current.facingMode : null);
  if (!side) return null;
  const primary = choices.find((choice) => choice.side === side && choice.primary);
  const second = choices.find((choice) => choice.side === side && !choice.primary);
  if (!primary || !second) return null;
  const active = matched?.side === side ? matched.deviceId : primary.deviceId;
  const lens = (choice: CameraChoice, short: string): Lens => ({
    deviceId: choice.deviceId,
    short,
    label: choice.label,
    active: choice.deviceId === active,
    wide: choice.wide,
  });
  return second.wide ? [lens(second, '0.5×'), lens(primary, '1×')] : [lens(primary, '1'), lens(second, '2')];
}

/** Зум дорожки камеры: диапазон из `getCapabilities().zoom` и нынешнее значение. */
export interface Zoom {
  min: number;
  max: number;
  value: number;
}

/**
 * Зум, если платформа его отдаёт: Chrome на Android и камеры с PTZ на компьютере — при
 * `zoom: true` в захвате (`cameraCapture`); Safari, Firefox и поддельная камера Chromium — нет.
 */
export function readZoom(media: MediaStreamTrack): Zoom | null {
  const zoom = (media.getCapabilities?.() as { zoom?: { min?: number; max?: number } } | undefined)?.zoom;
  if (!zoom || typeof zoom.min !== 'number' || typeof zoom.max !== 'number' || !(zoom.max > zoom.min))
    return null;
  const current = (media.getSettings?.() as { zoom?: number } | undefined)?.zoom;
  return { min: zoom.min, max: zoom.max, value: typeof current === 'number' ? current : zoom.min };
}

/** Ступень зума «0.5× · 1× · 2×» (R36): чем её включить — другой линзой или значением зума. */
export interface ZoomStep {
  /** Множитель для человека: 0.5, 1 или 2. */
  factor: 0.5 | 1 | 2;
  /** Перейти на эту линзу (широкоугольная или назад на основную). */
  deviceId?: string;
  /** Значение ограничения `zoom` нынешней линзы. */
  zoom?: number;
  active: boolean;
}

/**
 * Какие ступени зума показывать: только те, что камера умеет на самом деле (R36).
 *
 * «1×» — начало диапазона, если он не меньше единицы (у веб-камер зум бывает в своих единицах,
 * 100…500), иначе единица. «2×» — когда зум дотягивается вдвое. «0.5×» — когда зум сам умеет
 * отдалить вдвое (логическая камера Android, 0.5…10) или есть широкоугольная линза (`lensesFor`).
 * На широкоугольной линзе диапазон зума — её собственный, поэтому «1×» возвращает основную линзу,
 * а «2×» не обещается. Одна ступень — не выбор: тогда список пуст и контрол не показывается.
 */
export function zoomSteps({ lenses, zoom }: { lenses: Lens[] | null; zoom: Zoom | null }): ZoomStep[] {
  const wide = lenses?.find((lens) => lens.wide);
  const main = wide ? lenses?.find((lens) => !lens.wide) : undefined;
  const onWide = !!wide?.active;
  const range = zoom && zoom.max > zoom.min ? zoom : null;
  const base = range ? Math.max(range.min, 1) : 1;
  // Сравнение с запасом: камера округляет значение до своего шага.
  const near = (value: number, target: number) => Math.abs(value - target) <= target * 0.02;
  const steps: ZoomStep[] = [];
  if (range && !onWide && range.min <= base / 2 + 1e-9)
    steps.push({ factor: 0.5, zoom: base / 2, active: near(range.value, base / 2) });
  else if (wide && main) steps.push({ factor: 0.5, deviceId: wide.deviceId, active: onWide });
  if (onWide && main) steps.push({ factor: 1, deviceId: main.deviceId, active: false });
  else if (range) steps.push({ factor: 1, zoom: base, active: near(range.value, base) });
  else if (wide && main) steps.push({ factor: 1, deviceId: main.deviceId, active: true });
  if (range && !onWide && range.max >= base * 2 - 1e-9)
    steps.push({ factor: 2, zoom: base * 2, active: near(range.value, base * 2) });
  return steps.length > 1 ? steps : [];
}

/** Камеры устройства вместе с их возможностями, насколько платформа их сообщает. */
export async function readCameras(): Promise<CameraInput[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'videoinput')
    .map((device) => {
      // `getCapabilities` есть не у всех и требует разрешения; его отсутствие не повод падать.
      const capabilities = (
        device as MediaDeviceInfo & { getCapabilities?: () => MediaTrackCapabilities }
      ).getCapabilities?.();
      return {
        deviceId: device.deviceId,
        label: device.label ?? '',
        facingMode: capabilities?.facingMode,
      };
    });
}
