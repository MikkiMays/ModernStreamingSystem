// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CapturePicker } from './CapturePicker';

/*
  Окно выбора источника в клиенте на Electron (E01-B2): вкладки «Экраны» / «Окна», плитки,
  «Со звуком системы» только с флагом оболочки, «Показать» — после выбора.
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

async function open(features: string[], sources: unknown = list) {
  fakeDesktop(features, sources);
  const onChoose = vi.fn();
  const onOpenChange = vi.fn();
  render(<CapturePicker open onOpenChange={onOpenChange} onChoose={onChoose} />);
  await act(async () => {});
  return { onChoose, onOpenChange };
}

const sourcesGroup = () => screen.getByRole('group', { name: 'Источники' });

describe('окно выбора источника', () => {
  it('экраны по умолчанию, окна — на своей вкладке; «Показать» ждёт выбора', async () => {
    const { onChoose } = await open(['capture', 'capture.system-audio']);
    expect(screen.getByRole('heading', { name: 'Что показать' })).toBeInTheDocument();
    const tiles = within(sourcesGroup()).getAllByRole('button');
    expect(tiles.map((tile) => tile.textContent)).toEqual(['Экран 1', 'Экран 2']);
    const share = screen.getByRole('button', { name: 'Показать' });
    expect(share).toBeDisabled();
    fireEvent.click(tiles[1]!);
    expect(tiles[1]).toHaveAttribute('aria-pressed', 'true');
    expect(share).toBeEnabled();
    fireEvent.click(share);
    expect(onChoose).toHaveBeenCalledWith({ id: 'screen:1:0', audio: 'none' });
    fireEvent.click(screen.getByRole('tab', { name: 'Окна' }));
    await act(async () => {});
    expect(
      within(sourcesGroup())
        .getAllByRole('button')
        .map((tile) => tile.textContent),
    ).toEqual(['Counter-Strike 2']);
  });

  it('«Со звуком системы» — только с флагом Windows; включённый уходит режимом system', async () => {
    const { onChoose } = await open(['capture', 'capture.system-audio']);
    fireEvent.click(screen.getByRole('switch', { name: /Со звуком системы/ }));
    fireEvent.doubleClick(within(sourcesGroup()).getAllByRole('button')[0]!);
    expect(onChoose).toHaveBeenCalledWith({ id: 'screen:0:0', audio: 'system' });
    cleanup();
    await open(['capture']);
    expect(screen.queryByRole('switch', { name: /Со звуком системы/ })).toBeNull();
  });

  it('с capture.app-audio — четыре режима звука; «Звук приложения» — только у окна', async () => {
    const { onChoose } = await open(['capture', 'capture.system-audio', 'capture.app-audio'], {
      ...list,
      appAudio: true,
    });
    expect(screen.queryByRole('switch', { name: /Со звуком системы/ })).toBeNull();
    const sound = screen.getByRole('radiogroup', { name: 'Звук' });
    const names = () =>
      within(sound)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')!.textContent);
    expect(names()).toEqual(['Без звука', 'Звук системы', 'Система кроме Cord']);
    expect(within(sound).getByRole('radio', { name: 'Без звука' })).toBeChecked();
    fireEvent.click(within(sound).getByRole('radio', { name: 'Система кроме Cord' }));
    expect(screen.getByText('Весь звук компьютера, кроме самого Cord.')).toBeInTheDocument();
    fireEvent.doubleClick(within(sourcesGroup()).getAllByRole('button')[0]!);
    expect(onChoose).toHaveBeenLastCalledWith({ id: 'screen:0:0', audio: 'system-except-cord' });
    fireEvent.click(screen.getByRole('tab', { name: 'Окна' }));
    await act(async () => {});
    fireEvent.click(within(sourcesGroup()).getByRole('button', { name: /Counter-Strike 2/ }));
    expect(names()).toEqual(['Без звука', 'Звук системы', 'Звук приложения', 'Система кроме Cord']);
    fireEvent.click(within(sound).getByRole('radio', { name: 'Звук приложения' }));
    expect(screen.getByText(/голоса встречи в показ не попадут/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Показать' }));
    expect(onChoose).toHaveBeenLastCalledWith({ id: 'window:42:0', audio: 'app' });
  });

  it('«Звук приложения» у экрана не уходит: выбор экрана возвращает «Без звука»', async () => {
    const { onChoose } = await open(['capture', 'capture.app-audio'], {
      ...list,
      systemAudio: false,
      appAudio: true,
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Окна' }));
    await act(async () => {});
    fireEvent.click(within(sourcesGroup()).getByRole('button', { name: /Counter-Strike 2/ }));
    fireEvent.click(screen.getByRole('radio', { name: 'Звук приложения' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Экраны' }));
    await act(async () => {});
    fireEvent.click(within(sourcesGroup()).getAllByRole('button')[0]!);
    expect(screen.queryByRole('radio', { name: 'Звук приложения' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Звук системы' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Без звука' })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Показать' }));
    expect(onChoose).toHaveBeenLastCalledWith({ id: 'screen:0:0', audio: 'none' });
  });

  it('без capture.app-audio режимов нет — прежний выключатель системного звука', async () => {
    await open(['capture', 'capture.system-audio'], { ...list, appAudio: true });
    expect(screen.queryByRole('radiogroup', { name: 'Звук' })).toBeNull();
    expect(screen.getByRole('switch', { name: /Со звуком системы/ })).toBeInTheDocument();
  });

  it('пусто — понятная строка, «Отмена» закрывает', async () => {
    const { onOpenChange } = await open(['capture'], { systemAudio: false, sources: [] });
    expect(screen.getByText('Экраны не найдены.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
