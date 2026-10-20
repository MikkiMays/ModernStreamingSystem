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

  it('пусто — понятная строка, «Отмена» закрывает', async () => {
    const { onOpenChange } = await open(['capture'], { systemAudio: false, sources: [] });
    expect(screen.getByText('Экраны не найдены.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
