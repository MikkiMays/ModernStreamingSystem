// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicApi } from '../api/client';
import { Prejoin } from './Prejoin';

vi.mock('../api/client', async (load) => ({
  ...(await load<typeof import('../api/client')>()),
  prepareHuman: vi.fn(),
  publicApi: { create: vi.fn(), join: vi.fn(), joinCode: vi.fn() },
}));
// Модуль встречи предвход только подгружает заранее — здесь он не нужен.
vi.mock('../media/session', () => ({}));

/*
  Предвход (R72–R74): без пояснений и «айбрау», «Кто может войти» — сегментом, интеграции —
  переключателем, отказ устройства — строкой под превью и только после отказа; окно «Перед
  разговором» — окно набора с качеством сегментами 720 / 1080 / 1440 и 30 / 60 (R78).
*/

/** Поток предпросмотра: в jsdom `MediaStream` нет — хватает пустого набора дорожек. */
class FakeStream {
  private tracks: MediaStreamTrack[] = [];
  getTracks = () => this.tracks;
  getVideoTracks = () => this.tracks.filter((track) => track.kind === 'video');
  addTrack = (track: MediaStreamTrack) => void this.tracks.push(track);
  removeTrack = (track: MediaStreamTrack) => void (this.tracks = this.tracks.filter((t) => t !== track));
}

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeStream);
  localStorage.clear();
  localStorage.setItem('cord:name', 'Ника');
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => []),
      getUserMedia: vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const show = (onJoin = vi.fn()) => {
  render(<Prejoin destination={null} onBack={vi.fn()} onJoin={onJoin} />);
  return onJoin;
};

describe('предвход', () => {
  it('новая встреча: имя в фокусе, «Кто может войти» — сегмент, интеграции — переключатель, без пояснений', () => {
    show();
    expect(screen.getByRole('heading', { level: 1, name: 'Готовы к разговору?' })).toBeInTheDocument();
    expect(screen.getByLabelText('Ваше имя')).toHaveFocus();
    expect(screen.getByLabelText('Название встречи')).toHaveValue('Наша встреча');
    const access = screen.getByRole('radiogroup', { name: 'Кто может войти' });
    expect(within(access).getByRole('radio', { name: 'Сразу по ссылке' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(access).getByRole('radio', { name: 'С подтверждения' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('switch', { name: 'Разрешить интеграции всем участникам' })).toBeChecked();
    expect(screen.queryByRole('checkbox')).toBeNull();
    // R74: ни «айбрау», ни советов, ни «поменять можно потом».
    for (const text of [
      'НОВАЯ ВСТРЕЧА',
      /Проверьте, как вас видят/,
      /Название можно будет поменять/,
      /Это можно поменять и потом/,
      /рекомендуем наушники/,
      /Иначе кинозал и музыку/,
      /Ссылка и QR/,
      /Разрешение потребуется/,
    ])
      expect(screen.queryByText(text)).toBeNull();
    expect(screen.getByRole('button', { name: 'Начать встречу' })).toBeEnabled();
  });

  it('выбор «С подтверждения» и выключенные интеграции уходят в команду создания', async () => {
    vi.mocked(publicApi.create).mockResolvedValue({ roomId: 'r' } as never);
    const onJoin = show();
    fireEvent.click(screen.getByRole('radio', { name: 'С подтверждения' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Разрешить интеграции всем участникам' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Начать встречу' }));
    });
    expect(publicApi.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Ника', approvalRequired: true, integrationsAllowed: false }),
      undefined,
    );
    expect(onJoin).toHaveBeenCalledWith({ roomId: 'r' }, expect.objectContaining({ micOn: false }));
  });

  it('вход по коду — только имя: ни названия, ни доступа, ни интеграций', () => {
    render(<Prejoin destination={{ kind: 'code', code: '123456789' }} onBack={vi.fn()} onJoin={vi.fn()} />);
    expect(screen.queryByLabelText('Название встречи')).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Кто может войти' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByRole('button', { name: 'Войти во встречу' })).toBeInTheDocument();
  });

  it('отказ камеры — строкой под превью с «Поддержкой», а не в форме', async () => {
    show();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Включить камеру' }));
    });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Не удалось получить доступ к устройству/);
    expect(alert.closest('.prejoin-preview')).not.toBeNull();
    expect(within(alert).getByRole('button', { name: 'Поддержка' })).toBeInTheDocument();
  });

  it('телефон: превью — фронтальная, хотя запомнена задняя; её и показывает список, и берёт встреча (Р-35)', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(pointer: coarse)',
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ devices: { camera: 'back-camera' } }));
    const front = {
      kind: 'video',
      stop: vi.fn(),
      getSettings: () => ({ deviceId: 'front-camera', facingMode: 'user' }),
    };
    const getUserMedia = vi.mocked(navigator.mediaDevices.getUserMedia);
    getUserMedia.mockResolvedValue({ getTracks: () => [front], getVideoTracks: () => [front] } as never);
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([
      { kind: 'videoinput', deviceId: 'front-camera', label: 'Передняя камера', groupId: '' },
      { kind: 'videoinput', deviceId: 'back-camera', label: 'Задняя камера', groupId: '' },
    ] as never);
    vi.mocked(publicApi.create).mockResolvedValue({ roomId: 'r' } as never);
    const onJoin = show();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Включить камеру' }));
    });
    const asked = getUserMedia.mock.calls[0]![0]!.video as MediaTrackConstraints;
    expect(asked).toMatchObject({ facingMode: 'user' });
    expect(asked.deviceId).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Настройки предпросмотра' }));
    const dialog = await screen.findByRole('dialog', { name: 'Перед разговором' }, { timeout: 5000 });
    expect(within(dialog).getByRole('combobox', { name: 'Камера' })).toHaveValue('front-camera');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Начать встречу' }));
    });
    expect(onJoin).toHaveBeenCalledWith(
      { roomId: 'r' },
      expect.objectContaining({ cameraOn: true, camera: 'front-camera' }),
    );
  });

  it('«Перед разговором» — окно набора; качество камеры по умолчанию 480p · 30 сегментами (R72, R78)', async () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Настройки предпросмотра' }));
    const dialog = await screen.findByRole('dialog', { name: 'Перед разговором' }, { timeout: 5000 });
    expect(dialog).toHaveClass('ui-dialog');
    expect(within(dialog).getByRole('combobox', { name: 'Микрофон' })).toBeInTheDocument();
    const camera = within(dialog).getByRole('radiogroup', { name: 'Камера: качество' });
    expect(within(camera).getByRole('radio', { name: '480p' })).toHaveAttribute('aria-checked', 'true');
    const fps = within(dialog).getByRole('radiogroup', { name: 'Камера: частота кадров' });
    expect(within(fps).getByRole('radio', { name: '30 fps' })).toHaveAttribute('aria-checked', 'true');
    // Без «Чужого видео» и без подзаголовка про сохранение настроек.
    expect(within(dialog).queryByText(/сохраняются на этом устройстве/)).toBeNull();
    expect(within(dialog).queryByRole('combobox', { name: /Качество приёма/ })).toBeNull();
  });
});
