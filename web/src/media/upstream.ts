/**
 * Что отдавать в сеть, когда включено всё сразу.
 *
 * ЗАЧЕМ. До этого модуля каждая исходящая дорожка жила сама по себе. Экран 1080p30 и камера
 * 720p30, обе с simulcast, просят у канала почти 12 Мбит/с и **шесть одновременно работающих
 * кодировщиков** с одной машины — это и есть ответ на «включил всё сразу — и поплыло»:
 * упирается не сервер, а отдача и процессор того, кто отдаёт (числа — в docs/capacity.md).
 *
 * ЧТО ЗДЕСЬ ТЕПЕРЬ (T44, П2). Лестницы «Авто» нет: выбранный уровень публикуется сразу, и всё,
 * что осталось от автоматики, — **удержание** (`hold.ts`): в окне разгона жалобы не считаются,
 * после него две жалобы подряд опускают разрешение на одну ступень не ниже 720p и возвращают
 * его, как только стало спокойно. Запись в настройках не меняется.
 *
 * Камера под демонстрацией **не ужимается по умолчанию**: человек выставил число, и молча
 * отдавать 640×360 — ровно то, на что жаловались. Сервер может велеть иначе
 * (`capabilities.quality.cameraYieldsToScreen`) — тогда камера идёт одним маленьким слоем на
 * время показа, причём ужимается в момент начала показа, а не по жалобе: ждать жалобы значит
 * сначала испортить экран. Экран же трогается только после того, как уступила камера, и не
 * раньше, чем эта уступка успела отразиться в оценке канала.
 *
 * Здесь нет ни LiveKit, ни браузера: на вход — что опубликовано и что говорит кодировщик,
 * на выход — что поменять. Всё решение проверяется без сети.
 */

import { HoldLevel } from './hold';
import type { ScreenProfile } from './profiles';

/** Каким кадром идёт камера. */
export type CameraRole =
  /** Камера — главное, что от нас видно: профиль целиком, с simulcast. */
  | 'full'
  /** Камера рядом с демонстрацией: один маленький слой. */
  | 'companion';

export interface UpstreamInputs {
  /** Опубликована ли демонстрация экрана. */
  sharing: boolean;
  /** Опубликована ли камера. */
  camera: boolean;
  /** Худший `qualityLimitationReason` среди исходящих видеодорожек. */
  limitation: string;
  /** Что выбрано для экрана и для камеры. */
  screenLevel: ScreenProfile;
  cameraLevel: ScreenProfile;
  /** Велел ли сервер камере уступать показу. */
  cameraYields: boolean;
}

export interface UpstreamChange {
  /** Новая роль камеры, если её надо сменить. */
  camera?: CameraRole;
  /** Новый уровень отдачи демонстрации, если его надо сменить. */
  screen?: ScreenProfile;
  /** Новый уровень отдачи камеры, если его надо сменить. */
  cameraLevel?: ScreenProfile;
}

/**
 * Сколько опросов после ужатия камеры не трогать экран, считая и тот, на котором ужали.
 *
 * Оценка канала не обновляется мгновенно: освободившиеся мегабиты браузер заметит через
 * несколько секунд. Опрос идёт раз в три секунды, поэтому два опроса — это шесть секунд
 * тишины, за которые уступка камеры успевает стать видимой. Без этой паузы экран падал бы
 * по той же жалобе, ради которой камеру и ужали, — то есть платили бы дважды.
 */
const GRACE_TICKS = 2;

export class UpstreamBudget {
  private role: CameraRole = 'full';
  private grace = 0;
  private screen?: HoldLevel;
  private camera?: HoldLevel;

  /** @param settleTicks сколько опросов после публикации или смены уровня жалобы не считаются */
  constructor(private readonly settleTicks: number) {}

  /** Какой кадр камеры сейчас считается правильным. */
  get cameraRole() {
    return this.role;
  }

  /**
   * Удержание под этим выбором — прежнее, пока выбор тот же: пересоздание при каждом опросе
   * стёрло бы счётчики «две жалобы подряд», и удержание перестало бы двигаться вообще.
   */
  private hold(current: HoldLevel | undefined, level: ScreenProfile) {
    return current?.holds(level) ? current : new HoldLevel(level, this.settleTicks);
  }

  /**
   * Один опрос статистики отдачи.
   *
   * @returns что изменить, или пустой объект, если всё и так на месте.
   */
  observe(input: UpstreamInputs): UpstreamChange {
    const change: UpstreamChange = {};
    this.screen = this.hold(this.screen, input.screenLevel);
    this.camera = this.hold(this.camera, input.cameraLevel);

    // Роль камеры определяется составом того, что мы отдаём, а не жалобами кодировщика:
    // рядом с демонстрацией камера маленькая всегда, а не только когда уже стало плохо.
    // Но только если сервер велел уступать: иначе выбранное число — указание, а не совет.
    const wanted: CameraRole = input.sharing && input.camera && input.cameraYields ? 'companion' : 'full';
    if (wanted !== this.role) {
      const demoted = wanted === 'companion';
      this.role = wanted;
      change.camera = wanted;
      // Ужали камеру — дайте каналу время это показать, прежде чем спрашивать с экрана.
      if (demoted) this.grace = GRACE_TICKS;
    }

    if (!input.sharing) {
      // Показа нет — камера и есть то, что видно, и удержание принадлежит ей.
      if (input.camera) {
        const next = this.camera.observe(input.limitation);
        if (next) change.cameraLevel = next;
      }
      return change;
    }

    if (this.grace > 0) {
      this.grace--;
      // Жалоба во время паузы не выбрасывается, а просто не считается против экрана.
      return change;
    }
    const next = this.screen.observe(input.limitation);
    if (next) change.screen = next;
    return change;
  }

  /** Камеру включили заново: уступки прошлого включения к новому отношения не имеют. */
  resetCamera() {
    this.camera = undefined;
  }

  /** Демонстрация закончилась: удержание экрана начинается заново в следующий раз. */
  reset() {
    this.screen = undefined;
    this.camera = undefined;
    this.grace = 0;
  }
}
