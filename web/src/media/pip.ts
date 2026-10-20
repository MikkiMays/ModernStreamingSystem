/**
 * «Свернуть в окно» — картинка в картинке поверх других приложений (W2, W3, `docs/mobile.md` §3).
 *
 * ПОЧЕМУ СВОЙ `<video>`, А НЕ ПЛИТКА. Окно PiP привязано к элементу: свернуть плитку значит
 * потерять окно, как только раскладка её перестроит, и не суметь сменить в окне говорящего.
 * Поэтому у встречи свой маленький элемент вне React, и в нём — лучший источник: демонстрация,
 * которую смотрим, камера говорящего, любая чужая камера. Элемент держится «заряженным» заранее:
 * `requestPictureInPicture` требует уже загруженных метаданных и вызывается строго из нажатия —
 * подключить дорожку в тот же момент не успеть.
 *
 * Адаптивный приём `livekit-client` узнаёт элемент в PiP (`isElementInPiP`) и не отписывает видео
 * у скрытой страницы — свёрнутое окно живёт и при свёрнутом браузере.
 *
 * Где работает: iOS 14+ (Safari: `requestPictureInPicture`, иначе `webkitSetPresentationMode`),
 * Chrome на Android 105+ и на ПК. Сам по себе окно открывает только настольный Chrome 120+ — через
 * действие `enterpictureinpicture` Media Session (W3); на телефонах — только кнопкой.
 */
import { Track } from 'livekit-client';
import { Store } from '../core/store';
import type { MediaTile } from './session';

/** Смена картинки в окне не чаще: иначе окно прыгает на каждом «угу». */
export const PIP_SWITCH_MS = 3_000;

/**
 * Что показывать в окне. Демонстрация, которую смотрим, важнее лиц; говорящий важнее молчащих;
 * своя камера окну не нужна — себя человек и так видит в зеркале.
 */
export function choosePipSource(
  tiles: readonly MediaTile[],
  context: { watching: string | null; speaking: readonly string[] },
): MediaTile | null {
  const remote = tiles.filter((tile) => !tile.local && !tile.muted && tile.track.kind === Track.Kind.Video);
  const screen = remote.find(
    (tile) => tile.source === Track.Source.ScreenShare && tile.participantId === context.watching,
  );
  if (screen) return screen;
  const cameras = remote.filter((tile) => tile.source === Track.Source.Camera);
  for (const id of context.speaking) {
    const speaker = cameras.find((tile) => tile.participantId === id);
    if (speaker) return speaker;
  }
  return cameras[0] ?? null;
}

interface WebkitVideo extends HTMLVideoElement {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
}

export interface PipState {
  /** Есть что свернуть и браузер умеет. */
  available: boolean;
  /** Окно открыто. */
  active: boolean;
}

export class PictureInPicture {
  readonly state = new Store<PipState>({ available: false, active: false });
  private video: WebkitVideo | null = null;
  private current: MediaTile | null = null;
  private wanted: MediaTile | null = null;
  private switchedAt = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private support: boolean | null = null;

  constructor(
    private readonly doc: Document | null = typeof document !== 'undefined' ? document : null,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Умеет ли браузер картинку в картинке вообще. Спрашивается один раз. */
  get supported(): boolean {
    if (this.support !== null) return this.support;
    const doc = this.doc;
    if (!doc) return (this.support = false);
    if ((doc as { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled) return (this.support = true);
    const probe = doc.createElement('video') as WebkitVideo;
    return (this.support =
      typeof probe.webkitSupportsPresentationMode === 'function' &&
      probe.webkitSupportsPresentationMode('picture-in-picture'));
  }

  private element(): WebkitVideo | null {
    if (this.video || !this.doc?.body) return this.video;
    const video = this.doc.createElement('video') as WebkitVideo;
    video.className = 'pip-source';
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    video.addEventListener('enterpictureinpicture', this.entered);
    video.addEventListener('leavepictureinpicture', this.left);
    video.addEventListener('webkitpresentationmodechanged', this.presentation);
    this.doc.body.append(video);
    this.video = video;
    return video;
  }

  /**
   * Лучший источник сейчас. Первый подключается сразу, дальше — не чаще {@link PIP_SWITCH_MS},
   * последний из предложенных: и в открытом окне (иначе оно прыгает на каждом «угу»), и в закрытом
   * (незачем переподключать дорожку на каждую смену говорящего, пока окно никто не открыл).
   * Браузер без PiP ничего не подключает вовсе.
   */
  update(tile: MediaTile | null) {
    if (this.disposed || !this.supported) return;
    this.wanted = tile;
    clearTimeout(this.timer);
    if (tile?.track === this.current?.track) {
      this.publish();
      return;
    }
    const wait = this.current ? PIP_SWITCH_MS - (this.now() - this.switchedAt) : 0;
    if (wait > 0 && tile) this.timer = setTimeout(() => this.update(this.wanted), wait);
    else this.attach(tile);
  }

  private attach(tile: MediaTile | null) {
    const video = tile || this.current ? this.element() : this.video;
    if (this.current && video) this.current.track.detach(video);
    this.current = tile;
    this.switchedAt = this.now();
    if (tile && video) {
      tile.track.attach(video);
      void video.play?.()?.catch(() => {});
    } else if (!tile && this.state.get().active) void this.exit();
    this.publish();
  }

  private publish() {
    const next = { available: !!this.current, active: this.state.get().active };
    const prev = this.state.get();
    if (prev.available !== next.available || prev.active !== next.active) this.state.set(next);
  }

  /** Открыть окно. Звать прямо из обработчика нажатия, до любого `await`. */
  enter(): boolean {
    const video = this.video;
    if (!video || !this.current || this.disposed) return false;
    try {
      if (typeof video.requestPictureInPicture === 'function' && this.doc?.pictureInPictureEnabled) {
        void video.requestPictureInPicture().catch((error) => {
          console.warn('[cord] picture-in-picture refused', error);
        });
        return true;
      }
      if (video.webkitSupportsPresentationMode?.('picture-in-picture')) {
        video.webkitSetPresentationMode?.('picture-in-picture');
        return true;
      }
    } catch (error) {
      console.warn('[cord] picture-in-picture refused', error);
    }
    return false;
  }

  async exit() {
    const video = this.video;
    if (!video) return;
    try {
      if (this.doc?.pictureInPictureElement === video) await this.doc.exitPictureInPicture();
      else if (video.webkitPresentationMode === 'picture-in-picture')
        video.webkitSetPresentationMode?.('inline');
    } catch {
      /* Окно уже закрыли. */
    }
  }

  /** Открыть, если закрыто, закрыть, если открыто. Для кнопки. */
  toggle() {
    if (this.state.get().active) void this.exit();
    else this.enter();
  }

  private setActive(active: boolean) {
    if (this.state.get().active === active) return;
    this.state.set({ ...this.state.get(), active });
    // Пока окно было открыто, отложенная смена могла ждать: закрытое окно меняется сразу.
    if (!active && this.wanted?.track !== this.current?.track) {
      clearTimeout(this.timer);
      this.attach(this.wanted);
    }
  }

  private entered = () => this.setActive(true);
  private left = () => this.setActive(false);
  private presentation = () => this.setActive(this.video?.webkitPresentationMode === 'picture-in-picture');

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    const video = this.video;
    if (!video) return;
    void this.exit();
    if (this.current) this.current.track.detach(video);
    this.current = null;
    video.removeEventListener('enterpictureinpicture', this.entered);
    video.removeEventListener('leavepictureinpicture', this.left);
    video.removeEventListener('webkitpresentationmodechanged', this.presentation);
    video.remove();
    this.video = null;
    this.state.set({ available: false, active: false });
  }
}
