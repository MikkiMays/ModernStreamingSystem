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

export type CameraSide = 'user' | 'environment';

export interface CameraChoice {
  deviceId: string;
  /** Что показать человеку: «Фронтальная», «Основная», «Широкоугольная», «Вторая». */
  label: string;
  side: CameraSide;
  /** Первая линза стороны — та, которую браузер и так выбирает переворотом. */
  primary: boolean;
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
export function classifyCameras(cameras: CameraInput[]): CameraChoice[] {
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
      label: side === 'user' ? 'Фронтальная' : 'Основная',
      side,
      primary: true,
    });
    const second =
      rest.find((camera) => WIDE.test(camera.label)) ?? rest.find((camera) => !NARROW.test(camera.label));
    if (second)
      choices.push({
        deviceId: second.deviceId,
        label: WIDE.test(second.label)
          ? side === 'user'
            ? 'Фронтальная широкоугольная'
            : 'Широкоугольная'
          : side === 'user'
            ? 'Вторая фронтальная'
            : 'Вторая основная',
        side,
        primary: false,
      });
  }
  // Одна камера — это не выбор, а надпись. Показывать её списком незачем.
  return choices.length > 1 ? choices : [];
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
