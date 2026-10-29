import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../../core/meeting';
import { readPreferences, type Preferences } from '../../core/preferences';
import { Store } from '../../core/store';
import type { MediaTile } from '../../media/session';
import { VideoSection } from './VideoSection';

/*
  Какую камеру показывает превью «Видео» и что говорит список рядом. На телефоне превью — тоже
  включение камеры (Р-35): фронтальная, пока камеру в этой встрече не включали и не выбирали; потом —
  та, что включится. Выбор в списке переключает превью сразу на выбранную. На компьютере список, как и
  раньше, показывает сохранённое.
*/

function cameras(devices = ['front-camera', 'back-camera', 'wide-camera']) {
  const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
    const video = constraints.video as MediaTrackConstraints;
    const deviceId = video.facingMode === 'user' ? 'front-camera' : String(video.deviceId ?? 'usb-camera');
    const track = {
      kind: 'video',
      stop: vi.fn(),
      applyConstraints: vi.fn(async () => {}),
      getSettings: () => ({ deviceId, width: 640, height: 480, frameRate: 30 }),
    };
    return { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia,
      enumerateDevices: async () =>
        devices.map((deviceId) => ({ kind: 'videoinput', deviceId, label: deviceId, groupId: '' })),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  return getUserMedia;
}
const touch = (coarse: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: coarse && query === '(pointer: coarse)',
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
const asked = (getUserMedia: ReturnType<typeof cameras>, call: number) =>
  getUserMedia.mock.calls[call]![0].video as MediaTrackConstraints;
const withCamera = (camera: string): Preferences => ({
  ...readPreferences(),
  devices: { ...readPreferences().devices, camera },
});
/** Встреча, где камера сейчас выключена; `chosen` — её уже включали или выбирали руками. */
const meetingWith = (chosen: boolean) =>
  ({
    media: {
      tracks: new Store<MediaTile[]>([]),
      cameraChosen: new Store(chosen),
      switchDevice: vi.fn(async () => {}),
      setCameraProfile: vi.fn(async () => {}),
      setProfile: vi.fn(async () => {}),
    },
  }) as unknown as Meeting;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

describe('превью «Видео»: какая камера', () => {
  it('телефон во встрече: камеру уже выбирали — превью показывает её, а не фронтальную', async () => {
    touch(true);
    const getUserMedia = cameras();
    render(
      <VideoSection preferences={withCamera('back-camera')} change={vi.fn()} meeting={meetingWith(true)} />,
    );
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(asked(getUserMedia, 0)).toMatchObject({ deviceId: 'back-camera' });
    expect(asked(getUserMedia, 0).facingMode).toBeUndefined();
  });

  it('телефон во встрече: камеру ещё не включали — фронтальная', async () => {
    touch(true);
    const getUserMedia = cameras();
    render(
      <VideoSection preferences={withCamera('back-camera')} change={vi.fn()} meeting={meetingWith(false)} />,
    );
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(asked(getUserMedia, 0)).toMatchObject({ facingMode: 'user' });
  });

  it('выбор в списке — один новый захват, сразу выбранной, хотя настройки ещё не записались', async () => {
    touch(true);
    const getUserMedia = cameras();
    render(<VideoSection preferences={withCamera('back-camera')} change={vi.fn()} />);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    const select = screen.getByRole('combobox', { name: 'Камера' });
    await vi.waitFor(() => expect(select).toHaveValue('front-camera'));
    fireEvent.change(select, { target: { value: 'wide-camera' } });
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    expect(asked(getUserMedia, 1)).toMatchObject({ deviceId: 'wide-camera' });
    expect(select).toHaveValue('wide-camera');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('компьютер: список показывает сохранённое, а не то, что захватилось', async () => {
    touch(false);
    const getUserMedia = cameras(['usb-camera']);
    render(<VideoSection preferences={withCamera('')} change={vi.fn()} />);
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('combobox', { name: 'Камера' })).toHaveValue('');
  });
});
