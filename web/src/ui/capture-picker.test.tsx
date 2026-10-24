// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ScreenProfile } from '../media/profiles';
import { CapturePicker } from './CapturePicker';

/*
  Окно показа в клиенте на Electron (R60, R80, R95, R82 → n05): вкладки «Приложения · Весь экран ·
  Устройства», плитки, «Звук компьютера» только с флагом оболочки, сводка режима, режим «Чёткость /
  Плавность», качество и превью в шестерёнке, одна кнопка «Показать» — после выбора.
*/

const thumb = 'data:image/png;base64,AAAA';

function fakeDesktop(features: string[], sources: unknown) {
  const api = {
    protocol: { major: 2, minor: 0 },
    features,
    app: { version: '1.0.0', arch: 'x64' },
    bootstrap: {
      profile: 'x'.repeat(43),
      theme: 'system',
      showPing: false,
      notificationSounds: true,
      autoConnect: true,
    },
    send: vi.fn(),
    invoke: vi.fn(async () => sources),
    on: vi.fn(() => () => {}),
  };
  (window as unknown as { cordDesktop?: unknown }).cordDesktop = api;
  return api;
}

let media: MediaDeviceInfo[] = [];
beforeEach(() => {
  media = [];
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices: vi.fn(async () => media) },
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { cordDesktop?: unknown }).cordDesktop;
});

const list = {
  systemAudio: true,
  sources: [
    { id: 'screen:0:0', name: 'Экран 1', kind: 'screen', thumbnail: thumb, icon: '' },
    { id: 'screen:1:0', name: 'Экран 2', kind: 'screen', thumbnail: '', icon: '' },
    { id: 'window:42:0', name: 'Counter-Strike 2', kind: 'window', thumbnail: thumb, icon: thumb },
  ],
};

const level: ScreenProfile = { resolution: 1080, fps: 30, mode: 'smooth', preview: true, audio: 'none' };

async function open(
  features: string[],
  sources: unknown = list,
  initial: ScreenProfile = level,
  camera?: string,
) {
  fakeDesktop(features, sources);
  const onChoose = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <CapturePicker open onOpenChange={onOpenChange} onChoose={onChoose} initial={initial} camera={camera} />,
  );
  await act(async () => {});
  return { onChoose, onOpenChange };
}

const sourcesGroup = () => screen.getByRole('group', { name: 'Источники' });
const tiles = () =>
  within(sourcesGroup())
    .getAllByRole('button')
    .map((tile) => tile.textContent);
const tab = async (name: string) => {
  fireEvent.click(screen.getByRole('tab', { name }));
  await act(async () => {});
};
const summary = () => document.querySelector('.capture-picker__summary')!.textContent;

describe('окно показа', () => {
  it('вкладки «Приложения · Весь экран · Устройства»; открывается «Весь экран»; «Показать» ждёт выбора', async () => {
    const { onChoose } = await open(['capture', 'capture.system-audio']);
    expect(screen.getByRole('heading', { name: 'Что показать' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((item) => item.textContent)).toEqual([
      'Приложения',
      'Весь экран',
      'Устройства',
    ]);
    expect(screen.getByRole('tab', { name: 'Весь экран' })).toHaveAttribute('aria-selected', 'true');
    expect(tiles()).toEqual(['Экран 1', 'Экран 2']);
    const share = screen.getByRole('button', { name: 'Показать' });
    expect(share).toBeDisabled();
    // Одна главная кнопка: «Отмена» — крестик окна.
    expect(screen.queryByRole('button', { name: 'Отмена' })).toBeNull();
    const second = within(sourcesGroup()).getAllByRole('button')[1]!;
    fireEvent.click(second);
    expect(second).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(share);
    expect(onChoose).toHaveBeenCalledWith({
      kind: 'source',
      id: 'screen:1:0',
      audio: 'none',
      profile: { ...level, audio: 'none' },
    });
    await tab('Приложения');
    expect(tiles()).toEqual(['Counter-Strike 2']);
  });

  it('режим и качество — сводкой; выбор уходит профилем показа (R95, R78)', async () => {
    const { onChoose } = await open(['capture']);
    expect(summary()).toBe('Плавность · 1080p · 30 fps');
    const mode = screen.getByRole('radiogroup', { name: 'Режим показа' });
    expect(
      within(mode)
        .getAllByRole('radio')
        .map((item) => item.textContent),
    ).toEqual(['Чёткость', 'Плавность']);
    fireEvent.click(within(mode).getByRole('radio', { name: 'Чёткость' }));
    // «Чёткость» держит кадр, а кадров — сколько позволяет канал: частота — верхняя.
    expect(summary()).toBe('Чёткость · 1080p · до 30 fps');
    fireEvent.click(screen.getByRole('button', { name: 'Настройки показа' }));
    const quality = await screen.findByRole('radiogroup', { name: 'Экран: качество' });
    fireEvent.click(within(quality).getByRole('radio', { name: '720p' }));
    fireEvent.click(
      within(screen.getByRole('radiogroup', { name: 'Экран: частота кадров' })).getByRole('radio', {
        name: '60 fps',
      }),
    );
    expect(summary()).toBe('Чёткость · 720p · до 60 fps');
    fireEvent.doubleClick(within(sourcesGroup()).getAllByRole('button')[0]!);
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'screen:0:0',
        profile: expect.objectContaining({ mode: 'sharp', resolution: 720, fps: 60 }),
      }),
    );
  });

  it('«Показывать превью зрителям» — в шестерёнке, по умолчанию как в настройках; выключенное уходит в профиль (R80)', async () => {
    const { onChoose } = await open(['capture']);
    fireEvent.click(screen.getByRole('button', { name: 'Настройки показа' }));
    const preview = await screen.findByRole('switch', { name: 'Показывать превью зрителям' });
    expect(preview).toBeChecked();
    fireEvent.click(preview);
    fireEvent.doubleClick(within(sourcesGroup()).getAllByRole('button')[0]!);
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ profile: expect.objectContaining({ preview: false }) }),
    );
  });

  it('«Звук компьютера» — только с флагом Windows: включённый уходит звуком системы с предупреждением', async () => {
    const { onChoose } = await open(['capture', 'capture.system-audio']);
    const sound = screen.getByRole('switch', { name: /Звук компьютера/ });
    expect(sound).not.toBeChecked();
    fireEvent.click(sound);
    expect(
      screen.getByText('Участники услышат весь звук компьютера — и голоса этой встречи.'),
    ).toBeInTheDocument();
    expect(summary()).toBe('Плавность · 1080p · 30 fps · Звук системы');
    fireEvent.doubleClick(within(sourcesGroup()).getAllByRole('button')[0]!);
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'screen:0:0',
        audio: 'system',
        profile: expect.objectContaining({ audio: 'system' }),
      }),
    );
    cleanup();
    await open(['capture']);
    expect(screen.queryByRole('switch', { name: /Звук/ })).toBeNull();
  });

  it('с capture.app-audio: у окна — «Звук приложения», у экрана — «Система кроме Cord»; режимы — в шестерёнке', async () => {
    const { onChoose } = await open(['capture', 'capture.system-audio', 'capture.app-audio'], {
      ...list,
      appAudio: true,
    });
    fireEvent.click(screen.getByRole('switch', { name: /Звук компьютера/ }));
    expect(summary()).toBe('Плавность · 1080p · 30 fps · Система кроме Cord');
    await tab('Приложения');
    fireEvent.click(within(sourcesGroup()).getByRole('button', { name: /Counter-Strike 2/ }));
    expect(screen.getByRole('switch', { name: 'Звук приложения' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Настройки показа' }));
    const modes = await screen.findByRole('radiogroup', { name: 'Звук' });
    expect(
      within(modes)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')!.textContent),
    ).toEqual(['Звук системы', 'Звук приложения', 'Система кроме Cord']);
    expect(within(modes).getByRole('radio', { name: 'Звук приложения' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Показать' }));
    expect(onChoose).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'window:42:0', audio: 'app' }));
  });

  it('звук прошлого показа помнится: окно открывается с ним', async () => {
    const { onChoose } = await open(['capture', 'capture.system-audio'], list, { ...level, audio: 'system' });
    expect(screen.getByRole('switch', { name: /Звук компьютера/ })).toBeChecked();
    fireEvent.doubleClick(within(sourcesGroup()).getAllByRole('button')[0]!);
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ audio: 'system' }));
  });

  it('«Устройства»: карты захвата без своей камеры; звук устройства — если у него есть вход', async () => {
    media = [
      { kind: 'videoinput', deviceId: 'cam', groupId: 'g1', label: 'Встроенная камера' },
      { kind: 'audioinput', deviceId: 'mic', groupId: 'g1', label: 'Встроенный микрофон' },
      { kind: 'videoinput', deviceId: 'elgato', groupId: 'g2', label: 'Elgato HD60' },
      { kind: 'audioinput', deviceId: 'elgato-audio', groupId: 'g2', label: 'Elgato HD60 Audio' },
      { kind: 'videoinput', deviceId: 'obs', groupId: 'g3', label: '' },
    ].map((item) => ({ ...item, toJSON: () => item }) as MediaDeviceInfo);
    const { onChoose } = await open(['capture'], list, level, 'cam');
    await tab('Устройства');
    expect(tiles()).toEqual(['Elgato HD60', 'Устройство 2']);
    fireEvent.click(within(sourcesGroup()).getByRole('button', { name: 'Elgato HD60' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Звук устройства' }));
    expect(summary()).toBe('Плавность · 1080p · 30 fps · Звук устройства');
    fireEvent.click(screen.getByRole('button', { name: 'Показать' }));
    expect(onChoose).toHaveBeenCalledWith({
      kind: 'device',
      deviceId: 'elgato',
      sound: true,
      profile: expect.objectContaining({ resolution: 1080 }),
    });
    // У виртуальной камеры без звукового входа выключателя звука нет.
    fireEvent.click(within(sourcesGroup()).getByRole('button', { name: 'Устройство 2' }));
    expect(screen.queryByRole('switch', { name: /Звук/ })).toBeNull();
  });

  it('пусто — понятная строка: экранов нет, устройств захвата нет', async () => {
    await open(['capture'], { systemAudio: false, sources: [] });
    expect(screen.getByText('Экраны не найдены.')).toBeInTheDocument();
    await tab('Устройства');
    expect(screen.getByText('Устройств захвата нет')).toBeInTheDocument();
  });
});
