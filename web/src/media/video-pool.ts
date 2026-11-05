/**
 * Один `<video>` на дорожку (R189, И5).
 *
 * ЧТО БЫЛО. Плитка живёт в разных родителях: сетка, крупно над лентой, лента рядом с показом. React при
 * переносе плитки сносит старое поддерево и строит новое, и вместе с ним — новый `<video>`: новый поток,
 * новый проигрыватель, плитка без кадра 60–170 мс (замер `backlog/journal/2026-11-05-r189-viewer.md`), а
 * если кадры в эту минуту не идут — без кадра до следующего. Автооткрытие показа делало это со всеми
 * камерами разом.
 *
 * ЧТО ТЕПЕРЬ. Элемент принадлежит дорожке, а не плитке. Плитка даёт пустой узел (`mount`), элемент едет в
 * него; проигрыватель, поток и последний кадр остаются. Порядок React этому помогает: cleanup эффекта
 * снесённой плитки идёт, пока её узлы ещё в документе, эффект новой — уже после вставки. Поэтому `unmount`
 * уводит элемент в невидимый отстойник — он не выпадает из документа ни на миг, — а `mount` забирает
 * оттуда, всё в одной фиксации, до отрисовки. `moveBefore` переносит, не вынимая из документа; без него
 * обычная вставка, и браузер мог поставить видео на паузу — тогда просим играть дальше. Никто не забрал за
 * {@link RELEASE_MS} — настоящий `detach`.
 *
 * LIVEKIT. `attach` — один раз, элемент уже стоит в плитке (иначе `adaptiveStream` при первой проверке
 * счёл бы его невидимым и попросил SFU не слать кадры). Наблюдатели LiveKit (`IntersectionObserver`,
 * `ResizeObserver`) следят за элементом, а не за местом: после переезда сообщают новый размер сами.
 *
 * ЧЕРНОТЫ НЕТ. Видео открывается с первым кадром (`data-frame`), под ним аватар. Нет кадров — `<video>`
 * держит последний сам. Переподписка меняет дорожку, а старую LiveKit отвязывает раньше, чем мы об этом
 * узнаём; такой кадр держит снимок (`freeze`), он уходит с первым новым кадром.
 *
 * Здесь нет ни React, ни LiveKit: плитка зовёт {@link VideoPool.mount}, сторож (`camera-watch.ts`) — лечение.
 */

/** Сколько элемент ждёт новую плитку, прежде чем его по-настоящему отвязать. */
export const RELEASE_MS = 1000;
/** Потолок ширины снимка: он виден доли секунды, на него незачем тратить память. */
const FREEZE_WIDTH = 640;

/** Что пул просит у дорожки: `attach` и `detach` LiveKit. */
export interface PoolTrack {
  attach(element: HTMLMediaElement): HTMLMediaElement;
  detach(element: HTMLMediaElement): HTMLMediaElement;
}

export interface VideoView {
  /** Сейчас показывающий элемент: {@link VideoPool.replace} мог его сменить. */
  readonly video: HTMLVideoElement;
  unmount(): void;
}

/** Опрос элемента для сторожа. */
export interface VideoSample {
  /** Стоит, хотя поток у него есть. */
  paused: boolean;
  /** Счётчик показанных кадров; нет — браузер не умеет считать. */
  rendered?: number;
  /** Отметка последнего переезда: после него кадрам законно нужно время. */
  movedAt: number;
}

interface Entry {
  id: string;
  track: PoolTrack;
  surface: HTMLDivElement;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement | null;
  /** Плитки этой дорожки; видео — у последней. Обычно одна. */
  hosts: HTMLElement[];
  release?: ReturnType<typeof setTimeout>;
  frame: boolean;
  presented: number;
  armed: boolean;
  movedAt: number;
}

type Movable = HTMLElement & { moveBefore?: (node: Node, child: Node | null) => void };
type Quality = HTMLVideoElement & { getVideoPlaybackQuality?: () => { totalVideoFrames: number } };

export class VideoPool {
  private entries = new Map<string, Entry>();
  private park: HTMLElement | null = null;
  private moves = 0;

  /**
   * Поставить видео дорожки в пустой узел плитки. Звать из `useLayoutEffect`: до отрисовки, и cleanup
   * ({@link VideoView.unmount}) — пока старая плитка ещё в документе.
   */
  mount(id: string, track: PoolTrack, host: HTMLElement, className = 'camera-video'): VideoView {
    const known = this.entries.get(id);
    const entry = known ?? this.create(id, track, className);
    clearTimeout(entry.release);
    entry.release = undefined;
    entry.hosts.push(host);
    this.place(host, entry.surface);
    if (!known) track.attach(entry.video);
    else {
      entry.movedAt = ++this.moves;
      if (entry.track !== track) this.swap(entry, track);
      else this.keepPlaying(entry);
    }
    const pool = this;
    let mounted = true;
    return {
      get video() {
        return entry.video;
      },
      unmount() {
        if (!mounted) return;
        mounted = false;
        pool.unmount(entry, host);
      },
    };
  }

  /** Состояние элемента на экране. Нет плитки — опрашивать нечего: кадры там и не должны показываться. */
  sample(id: string): VideoSample | undefined {
    const entry = this.entries.get(id);
    if (!entry || !entry.hosts.length) return undefined;
    const { video } = entry;
    return {
      paused: !!video.srcObject && video.paused,
      rendered: this.rendered(entry),
      movedAt: entry.movedAt,
    };
  }

  /** @returns false — браузер запретил (нужно касание); остальные отказы — обычная гонка `play`. */
  async play(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return true;
    try {
      await entry.video.play();
      return true;
    } catch (error) {
      return !(error instanceof DOMException && error.name === 'NotAllowedError');
    }
  }

  /** Заново привязать дорожку к тому же элементу: новый поток у того же проигрывателя. */
  reattach(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.freeze(id);
    entry.track.detach(entry.video);
    entry.track.attach(entry.video);
    entry.movedAt = ++this.moves;
  }

  /** Новый элемент на том же месте: старый проигрыватель мог сломаться насовсем. */
  replace(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.freeze(id);
    const old = entry.video;
    entry.track.detach(old);
    old.remove();
    const video = this.createVideo(entry, old.className);
    const label = old.getAttribute('aria-label');
    if (label !== null) video.setAttribute('aria-label', label);
    video.style.transform = old.style.transform;
    entry.video = video;
    entry.armed = false;
    entry.frame = false;
    entry.surface.prepend(video);
    this.syncSurface(entry);
    entry.track.attach(video);
    this.armFirstFrame(entry);
    entry.movedAt = ++this.moves;
  }

  /**
   * Снять последний кадр на холст поверх видео. Звать перед тем, как дорожку снимут: LiveKit отвязывает
   * её сам (`srcObject = null`), и кадр пропадает вместе с потоком.
   */
  freeze(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    const { video } = entry;
    if (!video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(1, FREEZE_WIDTH / video.videoWidth);
    const canvas = entry.canvas ?? document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    try {
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch {
      return;
    }
    canvas.className = 'video-freeze';
    canvas.style.transform = video.style.transform;
    entry.surface.append(canvas);
    entry.canvas = canvas;
    this.syncSurface(entry);
  }

  /** Встреча кончилась, или тест: отвязать всё сейчас. */
  clear() {
    for (const entry of [...this.entries.values()]) this.destroy(entry);
    this.park?.remove();
    this.park = null;
  }

  private create(id: string, track: PoolTrack, className: string): Entry {
    const surface = document.createElement('div');
    surface.className = 'video-surface';
    const entry: Entry = {
      id,
      track,
      surface,
      video: null as unknown as HTMLVideoElement,
      canvas: null,
      hosts: [],
      frame: false,
      presented: 0,
      armed: false,
      movedAt: ++this.moves,
    };
    entry.video = this.createVideo(entry, className);
    surface.append(entry.video);
    this.armFirstFrame(entry);
    this.entries.set(id, entry);
    return entry;
  }

  private createVideo(entry: Entry, className: string) {
    const video = document.createElement('video');
    video.className = className;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    // Свойство `muted` не попадает в разметку, а Safari смотрит и на атрибут.
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    const onFrame = () => {
      if (entry.video === video) this.markFrame(entry);
    };
    video.addEventListener('loadeddata', onFrame);
    video.addEventListener('emptied', () => {
      if (entry.video !== video) return;
      entry.frame = false;
      this.syncSurface(entry);
      this.armFirstFrame(entry);
    });
    return video;
  }

  private swap(entry: Entry, track: PoolTrack) {
    entry.track.detach(entry.video);
    entry.track = track;
    entry.frame = false;
    this.syncSurface(entry);
    track.attach(entry.video);
    this.armFirstFrame(entry);
  }

  private unmount(entry: Entry, host: HTMLElement) {
    const index = entry.hosts.lastIndexOf(host);
    if (index < 0) return;
    const wasTop = index === entry.hosts.length - 1;
    entry.hosts.splice(index, 1);
    if (!wasTop) return;
    const previous = entry.hosts.at(-1);
    if (previous) {
      this.place(previous, entry.surface);
      entry.movedAt = ++this.moves;
      this.keepPlaying(entry);
      return;
    }
    this.place(this.parking(), entry.surface);
    entry.release = setTimeout(() => this.destroy(entry), RELEASE_MS);
  }

  private destroy(entry: Entry) {
    clearTimeout(entry.release);
    this.entries.delete(entry.id);
    entry.track.detach(entry.video);
    entry.surface.remove();
  }

  /** Перенести, не вынимая из документа, если браузер умеет и узел в документе. */
  private place(parent: Movable, node: HTMLElement) {
    if (node.parentElement === parent) return;
    if (parent.moveBefore && node.isConnected && parent.isConnected) {
      try {
        parent.moveBefore(node, null);
        return;
      } catch {
        // Узлы в разных деревьях: обычная вставка.
      }
    }
    parent.appendChild(node);
  }

  private parking() {
    if (!this.park || !this.park.isConnected) {
      this.park = document.createElement('div');
      this.park.className = 'video-pool-park';
      this.park.hidden = true;
      document.body.append(this.park);
    }
    return this.park;
  }

  /** Вынутое из документа видео браузер ставит на паузу; вернулось — пусть играет. */
  private keepPlaying({ video }: Entry) {
    if (video.srcObject && video.paused) void Promise.resolve(video.play()).catch(() => {});
  }

  private rendered(entry: Entry): number | undefined {
    const video = entry.video as Quality;
    const quality = video.getVideoPlaybackQuality?.().totalVideoFrames;
    const canCount = typeof video.requestVideoFrameCallback === 'function';
    if (canCount) this.armFrame(entry);
    if (!canCount && quality === undefined) return undefined;
    return entry.presented + (quality ?? 0);
  }

  private onPresented(entry: Entry, video: HTMLVideoElement, metadata?: VideoFrameCallbackMetadata) {
    if (entry.video !== video) return;
    entry.armed = false;
    entry.presented = Math.max(entry.presented + 1, metadata?.presentedFrames ?? 0);
    this.markFrame(entry);
  }

  /** Ждать первый кадр и по rVFC тоже: `loadeddata` в Safari приходит не всегда, когда кадр уже виден. */
  private armFirstFrame(entry: Entry) {
    if (!entry.frame) this.armFrame(entry);
  }

  /** Один взведённый rVFC на элемент: каждый кадр считать незачем, сторожу хватает одного за опрос. */
  private armFrame(entry: Entry) {
    const { video } = entry;
    if (entry.armed || typeof video.requestVideoFrameCallback !== 'function') return;
    entry.armed = true;
    video.requestVideoFrameCallback((_now, metadata) => this.onPresented(entry, video, metadata));
  }

  private markFrame(entry: Entry) {
    entry.frame = true;
    entry.canvas?.remove();
    entry.canvas = null;
    this.syncSurface(entry);
  }

  private syncSurface({ surface, frame, canvas }: Entry) {
    surface.toggleAttribute('data-frame', frame);
    surface.toggleAttribute('data-cover', frame || !!canvas);
  }
}

/** Пул страницы: встреча на странице одна, а плитке и сторожу нужен один и тот же элемент. */
export const videoPool = new VideoPool();
