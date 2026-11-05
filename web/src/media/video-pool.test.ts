import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASE_MS, VideoPool, type PoolTrack } from './video-pool';

/*
  Один `<video>` на дорожку (R189, И5). React сносит старую плитку и строит новую в одной фиксации: cleanup
  эффекта старой плитки идёт раньше, чем её узел вынут из документа, эффект новой — уже после. Здесь эта
  последовательность разыгрывается руками на настоящем DOM.
*/

function fakeTrack() {
  const attached: HTMLMediaElement[] = [];
  const track: PoolTrack & { attached: HTMLMediaElement[] } = {
    attached,
    attach: vi.fn((element: HTMLMediaElement) => {
      attached.push(element);
      // Настоящий `attachToElement` ставит поток: без него пул считал бы элемент пустым.
      Object.defineProperty(element, 'srcObject', { configurable: true, writable: true, value: {} });
      return element;
    }),
    detach: vi.fn((element: HTMLMediaElement) => {
      attached.splice(attached.indexOf(element), 1);
      Object.defineProperty(element, 'srcObject', { configurable: true, writable: true, value: null });
      return element;
    }),
  };
  return track;
}

const host = () => {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
};
const paused = (video: HTMLVideoElement, value: boolean) =>
  Object.defineProperty(video, 'paused', { configurable: true, value });

let pool: VideoPool;
beforeEach(() => {
  vi.useFakeTimers();
  // jsdom не умеет `play`, а у элемента с потоком и на паузе пул его зовёт.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  pool = new VideoPool();
});
afterEach(() => {
  pool.clear();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('перенос плитки', () => {
  it('первая установка: элемент уже в плитке, когда LiveKit его видит', () => {
    const track = fakeTrack();
    const slot = host();
    let connected = false;
    (track.attach as ReturnType<typeof vi.fn>).mockImplementation((element: HTMLMediaElement) => {
      connected = slot.contains(element);
      return element;
    });
    const view = pool.mount('TR', track, slot);
    expect(connected).toBe(true);
    expect(view.video.className).toBe('camera-video');
    expect(view.video.muted).toBe(true);
    expect(view.video.playsInline).toBe(true);
    expect(view.video.autoplay).toBe(true);
  });

  it('снятие и установка в одной фиксации: тот же элемент, ни detach, ни второго attach', () => {
    const track = fakeTrack();
    const first = host();
    const view = pool.mount('TR', track, first);
    const video = view.video;
    view.unmount();
    // Cleanup успел до того, как React вынул старую плитку: элемент не выпадал из документа.
    expect(video.isConnected).toBe(true);
    expect(first.contains(video)).toBe(false);
    first.remove();
    const second = host();
    const next = pool.mount('TR', track, second);
    expect(next.video).toBe(video);
    expect(second.contains(video)).toBe(true);
    expect(track.attach).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RELEASE_MS * 2);
    expect(track.detach).not.toHaveBeenCalled();
    expect(pool.sample('TR')).toBeDefined();
  });

  it('новая плитка пришла чуть позже — тот же элемент, пока не вышел срок', () => {
    const track = fakeTrack();
    const view = pool.mount('TR', track, host());
    const video = view.video;
    view.unmount();
    vi.advanceTimersByTime(RELEASE_MS - 1);
    expect(pool.mount('TR', track, host()).video).toBe(video);
    vi.advanceTimersByTime(RELEASE_MS);
    expect(track.detach).not.toHaveBeenCalled();
  });

  it('никто не пришёл — detach ровно один раз, элемент убран, следующая установка — новый элемент', () => {
    const track = fakeTrack();
    const view = pool.mount('TR', track, host());
    const video = view.video;
    view.unmount();
    vi.advanceTimersByTime(RELEASE_MS);
    expect(track.detach).toHaveBeenCalledTimes(1);
    expect(track.detach).toHaveBeenCalledWith(video);
    expect(video.isConnected).toBe(false);
    expect(track.attached).toEqual([]);
    expect(pool.sample('TR')).toBeUndefined();
    expect(pool.mount('TR', track, host()).video).not.toBe(video);
  });

  it('разобранная установка, снятая повторно, ничего не ломает', () => {
    const track = fakeTrack();
    const view = pool.mount('TR', track, host());
    view.unmount();
    view.unmount();
    vi.advanceTimersByTime(RELEASE_MS);
    expect(track.detach).toHaveBeenCalledTimes(1);
  });

  it('`moveBefore`, где он есть: без него браузер вынул бы элемент из документа', () => {
    const track = fakeTrack();
    const first = host();
    const view = pool.mount('TR', track, first);
    const second = host();
    const moveBefore = vi.fn(function (this: HTMLElement, node: Node) {
      this.append(node);
    });
    Object.assign(second, { moveBefore });
    const parked = view.video.parentElement!;
    view.unmount();
    pool.mount('TR', track, second);
    expect(moveBefore).toHaveBeenCalledWith(parked, null);
    expect(second.contains(view.video)).toBe(true);
  });

  it('`moveBefore` отказал (узел вне документа) — обычная вставка', () => {
    const track = fakeTrack();
    const view = pool.mount('TR', track, host());
    const second = host();
    Object.assign(second, {
      moveBefore: () => {
        throw new DOMException('no', 'HierarchyRequestError');
      },
    });
    view.unmount();
    pool.mount('TR', track, second);
    expect(second.contains(view.video)).toBe(true);
  });

  it('без `moveBefore` браузер мог поставить видео на паузу — просим играть дальше', () => {
    const track = fakeTrack();
    const view = pool.mount('TR', track, host());
    const play = vi.fn(async () => {});
    Object.assign(view.video, { play });
    paused(view.video, true);
    view.unmount();
    pool.mount('TR', track, host());
    expect(play).toHaveBeenCalledTimes(1);
  });

  it('две плитки одной дорожки: видео у последней, снятая верхняя отдаёт его предыдущей', () => {
    const track = fakeTrack();
    const first = host();
    const second = host();
    pool.mount('TR', track, first);
    const top = pool.mount('TR', track, second);
    expect(second.contains(top.video)).toBe(true);
    top.unmount();
    expect(first.contains(top.video)).toBe(true);
    vi.advanceTimersByTime(RELEASE_MS);
    expect(track.detach).not.toHaveBeenCalled();
  });

  it('снятая нижняя видео у верхней не отбирает', () => {
    const track = fakeTrack();
    const first = host();
    const second = host();
    const bottom = pool.mount('TR', track, first);
    const top = pool.mount('TR', track, second);
    bottom.unmount();
    expect(second.contains(top.video)).toBe(true);
    vi.advanceTimersByTime(RELEASE_MS);
    expect(track.detach).not.toHaveBeenCalled();
  });

  it('отметка переноса меняется при переезде и не меняется, пока плитка та же', () => {
    const track = fakeTrack();
    const slot = host();
    const view = pool.mount('TR', track, slot);
    const start = pool.sample('TR')!.movedAt;
    expect(pool.sample('TR')!.movedAt).toBe(start);
    view.unmount();
    pool.mount('TR', track, host());
    expect(pool.sample('TR')!.movedAt).not.toBe(start);
  });
});

describe('новая дорожка той же публикации (переподписка)', () => {
  it('тот же элемент, старая отвязана, новая привязана; кадр надо ждать заново', () => {
    const first = fakeTrack();
    const second = fakeTrack();
    const slot = host();
    const view = pool.mount('TR', first, slot);
    view.video.dispatchEvent(new Event('loadeddata'));
    view.unmount();
    const next = pool.mount('TR', second, slot);
    expect(next.video).toBe(view.video);
    expect(first.detach).toHaveBeenCalledWith(view.video);
    expect(second.attach).toHaveBeenCalledWith(view.video);
    expect(view.video.parentElement!.hasAttribute('data-frame')).toBe(false);
    vi.advanceTimersByTime(RELEASE_MS);
    expect(second.detach).not.toHaveBeenCalled();
  });
});

describe('первый кадр и последний кадр', () => {
  const stubCanvas = () =>
    vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage: vi.fn() } as unknown as ReturnType<HTMLCanvasElement['getContext']>);
  const sized = (video: HTMLVideoElement, width = 640, height = 360) => {
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: width });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: height });
  };

  it('видео открывается с первым кадром: `loadeddata`', () => {
    const view = pool.mount('TR', fakeTrack(), host());
    const surface = view.video.parentElement!;
    expect(surface.hasAttribute('data-frame')).toBe(false);
    view.video.dispatchEvent(new Event('loadeddata'));
    expect(surface.hasAttribute('data-frame')).toBe(true);
    expect(surface.hasAttribute('data-cover')).toBe(true);
  });

  it('видео открывается с первым кадром: `requestVideoFrameCallback`', () => {
    const callbacks: (() => void)[] = [];
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      callbacks.push(() => callback(0, { presentedFrames: 1 } as VideoFrameCallbackMetadata));
      return callbacks.length;
    };
    try {
      const view = pool.mount('TR', fakeTrack(), host());
      expect(view.video.parentElement!.hasAttribute('data-frame')).toBe(false);
      callbacks[0]!();
      expect(view.video.parentElement!.hasAttribute('data-frame')).toBe(true);
    } finally {
      HTMLVideoElement.prototype.requestVideoFrameCallback = original;
    }
  });

  it('перенесённое видео с кадром открыто сразу: новая плитка не ждёт кадра', () => {
    const track = fakeTrack();
    const view = pool.mount('TR', track, host());
    view.video.dispatchEvent(new Event('loadeddata'));
    view.unmount();
    const next = pool.mount('TR', track, host());
    expect(next.video.parentElement!.hasAttribute('data-frame')).toBe(true);
  });

  it('`emptied` (LiveKit снял дорожку) закрывает видео: под ним аватар, а не чёрное', () => {
    const view = pool.mount('TR', fakeTrack(), host());
    const surface = view.video.parentElement!;
    view.video.dispatchEvent(new Event('loadeddata'));
    view.video.dispatchEvent(new Event('emptied'));
    expect(surface.hasAttribute('data-frame')).toBe(false);
    expect(surface.hasAttribute('data-cover')).toBe(false);
  });

  it('снимок держит последний кадр, пока не пришёл новый, и убирается им', () => {
    stubCanvas();
    const view = pool.mount('TR', fakeTrack(), host());
    const surface = view.video.parentElement!;
    sized(view.video);
    view.video.dispatchEvent(new Event('loadeddata'));
    pool.freeze('TR');
    const canvas = surface.querySelector('canvas');
    expect(canvas).not.toBeNull();
    view.video.dispatchEvent(new Event('emptied'));
    expect(surface.querySelector('canvas')).toBe(canvas);
    expect(surface.hasAttribute('data-cover')).toBe(true);
    view.video.dispatchEvent(new Event('loadeddata'));
    expect(surface.querySelector('canvas')).toBeNull();
  });

  it('снимок — не больше своего потолка по ширине и зеркален как видео', () => {
    stubCanvas();
    const view = pool.mount('TR', fakeTrack(), host());
    sized(view.video, 1920, 1080);
    view.video.style.transform = 'scaleX(-1)';
    pool.freeze('TR');
    const canvas = view.video.parentElement!.querySelector('canvas')!;
    expect(canvas.width).toBeLessThanOrEqual(640);
    expect(canvas.height).toBe(Math.round((canvas.width * 1080) / 1920));
    expect(canvas.style.transform).toBe('scaleX(-1)');
  });

  it('снимать нечего (нет размера, нет холста) — ни снимка, ни ошибки', () => {
    const view = pool.mount('TR', fakeTrack(), host());
    pool.freeze('TR');
    expect(view.video.parentElement!.querySelector('canvas')).toBeNull();
    pool.freeze('нет такой');
  });
});

describe('опрос и лечение', () => {
  it('нет записи или элемент в отстойнике — опрашивать нечего', () => {
    const track = fakeTrack();
    expect(pool.sample('TR')).toBeUndefined();
    const view = pool.mount('TR', track, host());
    expect(pool.sample('TR')).toBeDefined();
    view.unmount();
    expect(pool.sample('TR')).toBeUndefined();
  });

  it('`paused` — только у элемента с потоком: снятая дорожка — не «видео стоит»', () => {
    const track = fakeTrack();
    const view = pool.mount('TR', track, host());
    paused(view.video, true);
    expect(pool.sample('TR')!.paused).toBe(true);
    Object.defineProperty(view.video, 'srcObject', { configurable: true, writable: true, value: null });
    expect(pool.sample('TR')!.paused).toBe(false);
  });

  it('счётчик показа: нет ни rVFC, ни качества воспроизведения — неизвестен', () => {
    pool.mount('TR', fakeTrack(), host());
    expect(pool.sample('TR')!.rendered).toBeUndefined();
  });

  it('счётчик показа растёт и по rVFC, и по `getVideoPlaybackQuality`', () => {
    const callbacks: ((metadata: VideoFrameCallbackMetadata) => void)[] = [];
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback;
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      callbacks.push((metadata) => callback(0, metadata));
      return callbacks.length;
    };
    try {
      const view = pool.mount('TR', fakeTrack(), host());
      const quality = { totalVideoFrames: 0 };
      Object.assign(view.video, { getVideoPlaybackQuality: () => quality });
      const start = pool.sample('TR')!.rendered!;
      expect(pool.sample('TR')!.rendered).toBe(start);
      // Опрос взводит один rVFC: кадр показан — счётчик вырос, и следующий опрос взводит новый.
      callbacks.at(-1)!({ presentedFrames: 5 } as VideoFrameCallbackMetadata);
      const afterFrame = pool.sample('TR')!.rendered!;
      expect(afterFrame).toBeGreaterThan(start);
      quality.totalVideoFrames = 3;
      expect(pool.sample('TR')!.rendered).toBeGreaterThan(afterFrame);
    } finally {
      HTMLVideoElement.prototype.requestVideoFrameCallback = original;
    }
  });

  it('play: сказал «нельзя» только за NotAllowedError', async () => {
    const view = pool.mount('TR', fakeTrack(), host());
    Object.assign(view.video, { play: vi.fn(async () => {}) });
    await expect(pool.play('TR')).resolves.toBe(true);
    Object.assign(view.video, {
      play: vi.fn(() => Promise.reject(new DOMException('no', 'NotAllowedError'))),
    });
    await expect(pool.play('TR')).resolves.toBe(false);
    Object.assign(view.video, { play: vi.fn(() => Promise.reject(new DOMException('no', 'AbortError'))) });
    await expect(pool.play('TR')).resolves.toBe(true);
    await expect(pool.play('нет такой')).resolves.toBe(true);
  });

  it('перепривязка: тот же элемент, detach и attach по разу', () => {
    const track = fakeTrack();
    const view = pool.mount('TR', track, host());
    pool.reattach('TR');
    expect(track.detach).toHaveBeenCalledTimes(1);
    expect(track.attach).toHaveBeenCalledTimes(2);
    expect(track.attached).toEqual([view.video]);
  });

  it('замена: новый элемент на том же месте, со всеми подписями; старый отвязан и убран', () => {
    const track = fakeTrack();
    const slot = host();
    const view = pool.mount('TR', track, slot);
    const old = view.video;
    old.setAttribute('aria-label', 'Камера: Аня');
    old.style.transform = 'scaleX(-1)';
    pool.replace('TR');
    expect(view.video).not.toBe(old);
    expect(old.isConnected).toBe(false);
    expect(slot.contains(view.video)).toBe(true);
    expect(view.video.getAttribute('aria-label')).toBe('Камера: Аня');
    expect(view.video.style.transform).toBe('scaleX(-1)');
    expect(view.video.className).toBe('camera-video');
    expect(track.attached).toEqual([view.video]);
    expect(pool.sample('TR')).toBeDefined();
  });

  it('лечить нечего — нет записи: тишина', () => {
    pool.reattach('нет такой');
    pool.replace('нет такой');
  });
});
