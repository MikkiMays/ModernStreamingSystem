/**
 * Что отдавать в сеть, когда включено всё сразу.
 *
 * ЗАЧЕМ. До этого модуля каждая исходящая дорожка жила сама по себе. Настройки по
 * умолчанию — экран 1080p30 и камера 720p30, обе с simulcast — просят у канала:
 *
 *   экран  1080p30 6,0 + слой 720p 2,0 + слой 360p 0,5 = 8,5 Мбит/с
 *   камера  720p30 2,5 + слой 360p 0,5 + слой 180p 0,15 = 3,15 Мбит/с
 *
 * Почти 12 Мбит/с и **шесть одновременно работающих кодировщиков** с одной машины. Это и
 * есть ответ на «включил всё сразу — и поплыло»: упирается не сервер, а отдача и процессор
 * того, кто отдаёт. Приёмник тут ни при чём, а сервер пересылает готовые пакеты и стоит
 * в разы меньше (числа — в docs/capacity.md).
 *
 * Хуже того, уступал не тот. `AutoQuality` следил **только за экраном**: когда кодировщику
 * становилось тесно, снижался экран — то самое, ради чего демонстрацию и включили, — а
 * камера продолжала занимать свои три мегабита. Порядок был обратный здравому смыслу.
 *
 * ЧТО ВМЕСТО. Пока идёт демонстрация, камера — заведомо младшая дорожка: её показывают
 * маленькой плиткой рядом с экраном, и 360p одним слоем там не отличить от 720p тремя.
 * Поэтому камера ужимается сразу при начале показа, а не после первой жалобы: ждать
 * жалобы — значит сначала испортить экран. Экран же трогается только после того, как
 * уступила камера, и не раньше, чем эта уступка успела отразиться в оценке канала.
 *
 * А КОГДА ПОКАЗА НЕТ, у камеры своя лестница. Раньше её не было вовсе: `monitorEncoder`
 * заводился внутри публикации экрана, и обычный разговор не опрашивал статистику отдачи
 * ни разу. «Авто» для камеры означало ровно одно фиксированное значение из настроек по
 * умолчанию — отсюда и «на Авто качество хуже, чем когда выставляешь руками».
 *
 * Здесь нет ни LiveKit, ни браузера: на вход — что опубликовано и что говорит кодировщик,
 * на выход — что поменять. Всё решение проверяется без сети.
 */

import { AutoQuality, ceilingFor, startingRung, type Rung } from './auto-quality';

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
  /** `availableOutgoingBitrate`, или null, когда браузер его не сообщает. */
  available: number | null;
  /** Двигать ли уровень демонстрации: выбранный вручную уровень — указание, а не совет. */
  screenAutomatic: boolean;
  /** То же для камеры. */
  cameraAutomatic: boolean;
  /** Выше какой ступени лестнице не подниматься. */
  screenCeiling?: Rung;
  cameraCeiling?: Rung;
}

export interface UpstreamChange {
  /** Новая роль камеры, если её надо сменить. */
  camera?: CameraRole;
  /** Новый уровень демонстрации, если его надо сменить. */
  screen?: Rung;
  /** Новый уровень камеры, если его надо сменить. */
  cameraLevel?: Rung;
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

/**
 * Лестница, которую не надо пересоздавать, пока потолок не изменился.
 *
 * Потолок приходит снаружи на каждом опросе, потому что человек может сменить уровень
 * посреди разговора. Пересоздание при каждом совпадающем значении стёрло бы накопленные
 * счётчики «две жалобы подряд» и лестница перестала бы двигаться вообще.
 */
class Ladder {
  private ceiling?: number;
  private quality: AutoQuality;
  constructor(limit?: Rung) {
    this.ceiling = limit && ceilingFor(limit);
    this.quality = this.build();
  }
  private build() {
    return this.ceiling === undefined
      ? new AutoQuality(startingRung)
      : new AutoQuality(Math.min(startingRung, this.ceiling), this.ceiling);
  }
  /** Потолок сменился — человек выбрал другой уровень, и прежняя лестница о нём не знает. */
  retarget(limit?: Rung) {
    const next = limit && ceilingFor(limit);
    if (next === this.ceiling) return;
    this.ceiling = next;
    this.quality = this.build();
  }
  observe(limitation: string, available: number | null) {
    return this.quality.observe(limitation, available);
  }
  get current() {
    return this.quality.current;
  }
}

export class UpstreamBudget {
  private role: CameraRole = 'full';
  private grace = 0;
  private auto = new Ladder();
  private cameraLadder = new Ladder();

  /** Какой кадр камеры сейчас считается правильным. */
  get cameraRole() {
    return this.role;
  }

  /** Уровень демонстрации, на котором остановилась автоматика. */
  get screenRung() {
    return this.auto.current;
  }

  /** Уровень камеры, на котором остановилась автоматика. */
  get cameraRung() {
    return this.cameraLadder.current;
  }

  /**
   * Один опрос статистики отдачи.
   *
   * @returns что изменить, или пустой объект, если всё и так на месте.
   */
  observe(input: UpstreamInputs): UpstreamChange {
    const change: UpstreamChange = {};
    this.auto.retarget(input.screenCeiling);
    this.cameraLadder.retarget(input.cameraCeiling);

    // Роль камеры определяется составом того, что мы отдаём, а не жалобами кодировщика:
    // рядом с демонстрацией камера маленькая всегда, а не только когда уже стало плохо.
    //
    // Но только в «Авто». Выбранный руками уровень — это указание, а не совет, и молча
    // подменять его на 360p значит ровно то, чего от настройки не ждут: человек выставил
    // число, а отдаётся другое, и узнать об этом можно было только из сноски в настройках.
    // Кто выбрал уровень сам, тот и решает, что делать с мегабитами, когда включает показ.
    const wanted: CameraRole = input.sharing && input.camera && input.cameraAutomatic ? 'companion' : 'full';
    if (wanted !== this.role) {
      const demoted = wanted === 'companion';
      this.role = wanted;
      change.camera = wanted;
      // Ужали камеру — дайте каналу время это показать, прежде чем спрашивать с экрана.
      if (demoted) this.grace = GRACE_TICKS;
    }

    if (!input.sharing) {
      // Показа нет — камера и есть то, что видно, и лестница принадлежит ей. Ужатая камера
      // здесь невозможна: роль выше уже вернулась к 'full'.
      if (input.camera && input.cameraAutomatic) {
        const next = this.cameraLadder.observe(input.limitation, input.available);
        if (next) change.cameraLevel = next;
      }
      return change;
    }

    if (!input.screenAutomatic) return change;
    if (this.grace > 0) {
      this.grace--;
      // Жалоба во время паузы не выбрасывается, а просто не считается против экрана:
      // счётчик `AutoQuality` не должен накопить её до того, как уступка камеры дошла.
      return change;
    }
    const next = this.auto.observe(input.limitation, input.available);
    if (next) change.screen = next;
    return change;
  }

  /** Демонстрация закончилась: лестница экрана начинается заново в следующий раз. */
  reset() {
    this.auto = new Ladder();
    this.cameraLadder = new Ladder();
    this.grace = 0;
  }
}
