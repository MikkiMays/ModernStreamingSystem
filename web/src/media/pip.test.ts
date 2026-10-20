import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Track } from 'livekit-client';
import { choosePipSource, PictureInPicture, PIP_SWITCH_MS } from './pip';
import type { MediaTile } from './session';

function tile(
  participantId: string,
  source: Track.Source,
  patch: Partial<MediaTile> = {},
): MediaTile & { track: { attach: ReturnType<typeof vi.fn>; detach: ReturnType<typeof vi.fn> } } {
  const kind = source === Track.Source.Microphone ? Track.Kind.Audio : Track.Kind.Video;
  return {
    id: `${participantId}:${source}`,
    participantId,
    name: participantId,
    source,
    track: { kind, attach: vi.fn(), detach: vi.fn() } as unknown as Track,
    local: false,
    muted: false,
    ...patch,
  } as never;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('что показать в окне PiP', () => {
  const anna = tile('anna', Track.Source.Camera);
  const boris = tile('boris', Track.Source.Camera);
  const borisScreen = tile('boris', Track.Source.ScreenShare);
  const me = tile('me', Track.Source.Camera, { local: true });

  it('демонстрация, которую смотрим, важнее лиц', () => {
    expect(choosePipSource([anna, boris, borisScreen], { watching: 'boris', speaking: ['anna'] })).toBe(
      borisScreen,
    );
  });

  it('дальше — камера говорящего, затем любая чужая камера', () => {
    expect(choosePipSource([anna, boris], { watching: null, speaking: ['boris'] })).toBe(boris);
    expect(choosePipSource([anna, boris], { watching: null, speaking: [] })).toBe(anna);
  });

  it('своя камера, выключенные камеры и звук в окно не идут', () => {
    const silent = tile('anna', Track.Source.Camera, { muted: true });
    const voice = tile('vera', Track.Source.Microphone);
    expect(choosePipSource([me, silent, voice], { watching: null, speaking: ['me'] })).toBeNull();
  });
});

describe('окно PiP', () => {
  beforeEach(() => {
    // jsdom не проигрывает видео и ругается на каждый play(): здесь важно только, что элемент заряжен.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  function supportPip() {
    Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
    const request = vi.fn(async () => ({}));
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', {
      value: request,
      configurable: true,
    });
    return request;
  }

  it('без источника недоступно; с источником — заряжено заранее и открывается нажатием', () => {
    const request = supportPip();
    const pip = new PictureInPicture(document, () => 0);
    expect(pip.state.get().available).toBe(false);
    const anna = tile('anna', Track.Source.Camera);
    pip.update(anna);
    const video = document.querySelector('video.pip-source') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(anna.track.attach).toHaveBeenCalledWith(video);
    expect(pip.state.get().available).toBe(true);
    expect(pip.enter()).toBe(true);
    expect(request).toHaveBeenCalled();
    pip.dispose();
    expect(document.querySelector('video.pip-source')).toBeNull();
    expect(anna.track.detach).toHaveBeenCalledWith(video);
  });

  it('в открытом окне говорящий меняется не чаще раза в три секунды, и побеждает последний', () => {
    vi.useFakeTimers();
    supportPip();
    let clock = 0;
    const pip = new PictureInPicture(document, () => clock);
    const anna = tile('anna', Track.Source.Camera);
    const boris = tile('boris', Track.Source.Camera);
    const vera = tile('vera', Track.Source.Camera);
    pip.update(anna);
    const video = document.querySelector('video.pip-source')!;
    video.dispatchEvent(new Event('enterpictureinpicture'));
    expect(pip.state.get().active).toBe(true);
    clock = 1_000;
    pip.update(boris);
    pip.update(vera);
    expect(boris.track.attach).not.toHaveBeenCalled();
    expect(vera.track.attach).not.toHaveBeenCalled();
    clock = PIP_SWITCH_MS;
    vi.advanceTimersByTime(PIP_SWITCH_MS);
    expect(boris.track.attach).not.toHaveBeenCalled();
    expect(vera.track.attach).toHaveBeenCalledWith(video);
    expect(anna.track.detach).toHaveBeenCalledWith(video);
    pip.dispose();
  });

  it('окно закрыли — ждавшая смена применяется сразу', () => {
    vi.useFakeTimers();
    supportPip();
    const pip = new PictureInPicture(document, () => 0);
    const anna = tile('anna', Track.Source.Camera);
    const boris = tile('boris', Track.Source.Camera);
    pip.update(anna);
    const video = document.querySelector('video.pip-source')!;
    video.dispatchEvent(new Event('enterpictureinpicture'));
    pip.update(boris);
    expect(boris.track.attach).not.toHaveBeenCalled();
    video.dispatchEvent(new Event('leavepictureinpicture'));
    expect(boris.track.attach).toHaveBeenCalledWith(video);
    pip.dispose();
  });

  it('и в закрытом окне дорожка не переподключается на каждую смену говорящего', () => {
    vi.useFakeTimers();
    supportPip();
    let clock = 0;
    const pip = new PictureInPicture(document, () => clock);
    const anna = tile('anna', Track.Source.Camera);
    const boris = tile('boris', Track.Source.Camera);
    pip.update(anna);
    clock = 500;
    pip.update(boris);
    expect(boris.track.attach).not.toHaveBeenCalled();
    clock = PIP_SWITCH_MS;
    vi.advanceTimersByTime(PIP_SWITCH_MS);
    expect(boris.track.attach).toHaveBeenCalled();
    pip.dispose();
  });

  it('браузер без PiP — пункта нет', () => {
    Object.defineProperty(document, 'pictureInPictureEnabled', { value: false, configurable: true });
    const pip = new PictureInPicture(document, () => 0);
    pip.update(tile('anna', Track.Source.Camera));
    expect(pip.state.get().available).toBe(false);
    pip.dispose();
  });
});
