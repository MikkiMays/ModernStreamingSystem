import { describe, expect, it, vi } from 'vitest';
import { SystemControls, type MediaSessionLike } from './system-controls';

function session(known: string[] = ['togglemicrophone', 'togglecamera', 'hangup', 'enterpictureinpicture']) {
  const handlers = new Map<string, (() => void) | null>();
  const fake: MediaSessionLike & { handlers: typeof handlers } = {
    handlers,
    metadata: null,
    setActionHandler: vi.fn((action: string, handler: (() => void) | null) => {
      if (!known.includes(action)) throw new TypeError(`unknown action ${action}`);
      handlers.set(action, handler);
    }),
    setMicrophoneActive: vi.fn(),
    setCameraActive: vi.fn(),
  };
  return fake;
}

const handlers = () => ({ microphone: vi.fn(), camera: vi.fn(), hangup: vi.fn(), pictureInPicture: vi.fn() });

describe('кнопки разговора в системе (Media Session)', () => {
  it('нажатия системы ведут к тем же действиям, что кнопки пульта', () => {
    const fake = session();
    const actions = handlers();
    new SystemControls(actions, fake);
    fake.handlers.get('togglemicrophone')?.();
    fake.handlers.get('togglecamera')?.();
    fake.handlers.get('hangup')?.();
    fake.handlers.get('enterpictureinpicture')?.();
    expect(actions.microphone).toHaveBeenCalledTimes(1);
    expect(actions.camera).toHaveBeenCalledTimes(1);
    expect(actions.hangup).toHaveBeenCalledTimes(1);
    expect(actions.pictureInPicture).toHaveBeenCalledTimes(1);
  });

  it('неизвестное браузеру действие не ломает остальные (Safari: hangup нет)', () => {
    const fake = session(['togglemicrophone', 'togglecamera']);
    const controls = new SystemControls(handlers(), fake);
    expect([...controls.actions]).toEqual(['togglemicrophone', 'togglecamera']);
  });

  it('сообщает системе, что включено, — только при изменении', () => {
    const fake = session();
    const controls = new SystemControls(handlers(), fake);
    controls.reflect({ microphone: true, camera: false });
    controls.reflect({ microphone: true, camera: false });
    controls.reflect({ microphone: false, camera: false });
    expect(fake.setMicrophoneActive).toHaveBeenCalledTimes(2);
    expect(fake.setMicrophoneActive).toHaveBeenLastCalledWith(false);
    expect(fake.setCameraActive).toHaveBeenCalledTimes(1);
  });

  it('метаданные — название встречи', () => {
    const fake = session();
    const controls = new SystemControls(handlers(), fake);
    controls.describe({ title: 'Планёрка', artist: 'Cord · встреча', artwork: [] });
    expect(fake.metadata).toMatchObject({ title: 'Планёрка', artist: 'Cord · встреча' });
  });

  it('уход со встречи снимает всё, и поздние нажатия ничего не делают', () => {
    const fake = session();
    const actions = handlers();
    const controls = new SystemControls(actions, fake);
    const late = fake.handlers.get('hangup')!;
    controls.dispose();
    late();
    expect(actions.hangup).not.toHaveBeenCalled();
    expect([...fake.handlers.values()].every((handler) => handler === null)).toBe(true);
    expect(fake.metadata).toBeNull();
  });

  it('без Media Session — тихо ничего', () => {
    const controls = new SystemControls(handlers(), null);
    controls.describe({ title: 'x', artist: 'y', artwork: [] });
    controls.reflect({ microphone: true, camera: true });
    controls.dispose();
    expect(controls.actions.size).toBe(0);
  });
});
