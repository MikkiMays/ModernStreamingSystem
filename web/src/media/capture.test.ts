import { afterEach, expect, it, vi } from 'vitest';
import { deviceCapture, ownAudioLeaks } from './capture';

const track = (settings: Record<string, unknown>) =>
  ({ getSettings: () => settings }) as unknown as MediaStreamTrack;

it('без звука утекать нечему', () => {
  expect(ownAudioLeaks(track({ displaySurface: 'monitor' }), undefined)).toBe(false);
});

it('звук вкладки не содержит нашего: там играет только она сама', () => {
  expect(ownAudioLeaks(track({ displaySurface: 'browser' }), track({ restrictOwnAudio: false }))).toBe(false);
});

it('звук всего экрана без исключения своего — это разговор в трансляции', () => {
  expect(ownAudioLeaks(track({ displaySurface: 'monitor' }), track({ restrictOwnAudio: false }))).toBe(true);
  // Поле может быть и вовсе неизвестно: подтверждения нет — значит, считаем, что утекает.
  expect(ownAudioLeaks(track({ displaySurface: 'monitor' }), track({}))).toBe(true);
});

it('исключение подтверждено самой дорожкой — жаловаться не на что', () => {
  expect(ownAudioLeaks(track({ displaySurface: 'monitor' }), track({ restrictOwnAudio: true }))).toBe(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `navigator.mediaDevices` с картой захвата (видео и звук одной группы) и камерой без звука. */
function devices() {
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => ({}) as MediaStream);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia,
      enumerateDevices: async () => [
        { kind: 'videoinput', deviceId: 'elgato', groupId: 'g2' },
        { kind: 'audioinput', deviceId: 'elgato-audio', groupId: 'g2' },
        { kind: 'videoinput', deviceId: 'obs', groupId: 'g3' },
      ],
    },
  });
  return getUserMedia;
}

it('устройство захвата (R60): тот же уровень, что у показа, звук — вход той же группы и без обработки', async () => {
  const getUserMedia = devices();
  await deviceCapture('elgato', { resolution: 1080, fps: 60 }, true);
  expect(getUserMedia).toHaveBeenCalledWith({
    video: {
      deviceId: { exact: 'elgato' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60, max: 60 },
    },
    audio: {
      deviceId: { exact: 'elgato-audio' },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
});

it('устройство без своего входа или звук не просили — только видео', async () => {
  const getUserMedia = devices();
  await deviceCapture('obs', { resolution: 720, fps: 30 }, true);
  await deviceCapture('elgato', { resolution: 720, fps: 30 }, false);
  expect(getUserMedia.mock.calls.map(([constraints]) => constraints.audio)).toEqual([false, false]);
});
