import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../core/store';
import type { Meeting } from '../core/meeting';
import type { Zoom } from '../media/cameras';
import { CameraSubmenu } from './CameraMenu';
import { Menu, MenuContent, MenuTrigger } from './kit';
import stage from './stage.css?raw';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const camera = (deviceId: string, label: string) =>
  ({ deviceId, label, kind: 'videoinput', groupId: '' }) as MediaDeviceInfo;

function stubDevices(devices: MediaDeviceInfo[]) {
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: { enumerateDevices: vi.fn(async () => devices) },
  });
}

function meeting(zoom: Zoom | null = null) {
  let current = zoom;
  const media = {
    preferences: new Store({ devices: { camera: 'cam-2', microphone: '', speaker: '' } }),
    switchDevice: vi.fn(async () => {}),
    flipCamera: vi.fn(async () => {}),
    cameraZoom: vi.fn(() => current),
    applyCameraZoom: vi.fn(async (value: number) => {
      if (current) current = { ...current, value };
    }),
  };
  return { media } as unknown as Meeting & { media: typeof media };
}

function show(target: Meeting) {
  render(
    <Menu defaultOpen>
      <MenuTrigger>Ещё</MenuTrigger>
      <MenuContent>
        <CameraSubmenu meeting={target} />
      </MenuContent>
    </Menu>,
  );
}

async function openCameras() {
  const trigger = await screen.findByRole('menuitem', { name: 'Камера' });
  fireEvent.click(trigger);
  return screen.findAllByRole('menu');
}

describe('подменю «Камера» (R35, R36)', () => {
  beforeEach(() => stubDevices([camera('cam-1', 'HD Webcam'), camera('cam-2', 'Logitech Brio')]));

  it('без «Следующей камеры»: только список камер, выбранная отмечена', async () => {
    show(meeting());
    await openCameras();
    const items = await screen.findAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['HD Webcam', 'Logitech Brio']);
    expect(items[1]).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText('Следующая камера')).toBeNull();
  });

  it('выбор камеры — через switchDevice', async () => {
    const target = meeting();
    show(target);
    await openCameras();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'HD Webcam' }));
    expect(target.media.switchDevice).toHaveBeenCalledWith('videoinput', 'cam-1');
    expect(target.media.flipCamera).not.toHaveBeenCalled();
  });

  it('камер нет — пункт выключен и говорит об этом', async () => {
    stubDevices([]);
    show(meeting());
    const item = await screen.findByRole('menuitem', { name: 'Камер не найдено' });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('menuitem', { name: 'Камера' })).toBeNull();
  });

  it('камера без зума — строки «Зум» нет (поддельная камера Chromium, обычная веб-камера)', async () => {
    show(meeting(null));
    await openCameras();
    await screen.findAllByRole('menuitemradio');
    expect(screen.queryByRole('group', { name: 'Зум' })).toBeNull();
  });

  it('камера с зумом — ступени «1×» и «2×», щелчок применяет зум и не закрывает меню', async () => {
    const target = meeting({ min: 100, max: 500, value: 100 });
    show(target);
    await openCameras();
    const group = await screen.findByRole('group', { name: 'Зум' });
    const steps = [...group.querySelectorAll('[role="menuitemradio"]')];
    expect(steps.map((step) => step.textContent)).toEqual(['1×', '2×']);
    expect(steps[0]).toHaveAttribute('aria-checked', 'true');
    await act(async () => {
      fireEvent.click(steps[1]!);
    });
    expect(target.media.applyCameraZoom).toHaveBeenCalledWith(200);
    await waitFor(() => expect(steps[1]).toHaveAttribute('aria-checked', 'true'));
    expect(group).toBeInTheDocument();
  });
});

it('зум на своей плитке стоит справа внизу, а не там, где сегмент набора (R36)', () => {
  // У `.ui-segmented` своё `position: relative`: без веса двух классов пилюля уезжала в угол плитки.
  expect(stage).toMatch(/\.lens-switch\.lens-switch--zoom \{\s*position: absolute;/);
  expect(stage).toMatch(
    /\.lens-switch \{\s*position: absolute;[^}]*right: var\(--space-2\);\s*bottom: var\(--space-2\);/,
  );
});
