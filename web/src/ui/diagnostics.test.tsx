import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import type { Sample } from '../media/diagnostics';

/*
  «Диагностика» (R47, R48): без подзаголовка «Проверьте устройства и фактическое соединение этой
  встречи.», «Подробности аудио и видео» — обычный раздел, не сворачиваемый `<details>`.
*/

const music: Sample = {
  kind: 'audio',
  outbound: false,
  direction: 'Получение',
  width: 0,
  height: 0,
  fps: 0,
  mbps: 0.16,
  loss: 0,
  limitation: 'none',
  transport: 'Прямой к SFU · UDP',
  rttMs: 57,
  codec: 'audio/opus',
  processingMs: null,
  bufferMs: 640,
  silentSource: false,
  concealmentEvents: 0,
  implementation: '',
  at: 0,
};
vi.mock('../media/diagnostics', () => ({
  StatsSampler: class {
    sample = async () => [music];
  },
}));

import Diagnostics from './Diagnostics';

afterEach(cleanup);

function fakeMeeting(tracks: unknown[] = []) {
  return {
    media: {
      preferences: new Store({ devices: {}, audio: {} }),
      state: new Store({ status: 'connected', quality: 'good' }),
      link: new Store({ path: 'udp', grade: 'good', jitterMs: 4, ordered: false }),
      tracks: new Store(tracks),
      playoutTargets: () => [{ kind: 'media', targetMs: 600 }],
      returnToLive: vi.fn(),
    },
    control: { state: new Store('connected') },
  } as unknown as Meeting;
}

describe('«Диагностика»', () => {
  it('без подзаголовка (R47): сразу проверка устройств, сеть и подробности', () => {
    render(<Diagnostics meeting={fakeMeeting()} onClose={vi.fn()} onHelp={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Диагностика' });
    expect(dialog).not.toHaveTextContent('Проверьте устройства и фактическое соединение этой встречи.');
    expect(dialog).not.toHaveAttribute('aria-describedby');
    for (const name of [
      'Проверьте себя',
      'Сеть',
      'Подробности аудио и видео',
      'Изображение или звук зависли?',
    ])
      expect(within(dialog).getByRole('heading', { name, level: 3 })).toBeInTheDocument();
  });

  it('«Подробности аудио и видео» статичны (R48): заголовок раздела, а не сворачиваемая строка', async () => {
    render(
      <Diagnostics
        meeting={fakeMeeting([{ name: 'Музыка', track: {} }])}
        onClose={vi.fn()}
        onHelp={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Диагностика' });
    expect(dialog.querySelector('details, summary')).toBeNull();
    const details = within(dialog)
      .getByRole('heading', { name: 'Подробности аудио и видео', level: 3 })
      .closest('section')!;
    // Дорожка — карточкой с заголовком и строками «подпись — значение».
    const track = await within(details as HTMLElement).findByRole('heading', {
      name: 'Музыка · Аудио · Получение',
      level: 4,
    });
    const rows = within(track.closest('article')!).getAllByRole('term');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Битрейт',
      'Потери пакетов за интервал',
      'Соединение',
      'RTT до медиасервера',
      'Кодек',
      'Буфер приёма',
    ]);
    expect(within(track.closest('article')!).getByText('160 Кбит/с')).toBeVisible();
  });

  it('«Помощь» внизу зовёт onHelp — диагностику закрывает и помощь открывает тот, кто её показал (R49)', () => {
    const onHelp = vi.fn();
    render(<Diagnostics meeting={fakeMeeting()} onClose={vi.fn()} onHelp={onHelp} />);
    fireEvent.click(screen.getByRole('button', { name: 'Помощь' }));
    expect(onHelp).toHaveBeenCalledTimes(1);
  });
});
