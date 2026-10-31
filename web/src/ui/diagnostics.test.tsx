import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import type { Sample } from '../media/diagnostics';

/*
  «Диагностика» (R47, R48, R29, R79): без подзаголовка «Проверьте устройства и фактическое соединение
  этой встречи.», «Подробности аудио и видео» — обычный раздел, не сворачиваемый `<details>`; у
  принятого звука — тишина отправителя и пропуски; «Скопировать отчёт о звонке» — без имён.
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
  silentSource: true,
  concealmentEvents: 3,
  implementation: '',
  at: 0,
};
/** Своя камера (R152): AV1 в железе, `L1T3`, профиль и время кадра. */
const camera: Sample = {
  ...music,
  kind: 'video',
  outbound: true,
  direction: 'Передача',
  width: 1280,
  height: 720,
  fps: 30,
  mbps: 2.4,
  loss: null,
  codec: 'video/AV1',
  processingMs: 3.2,
  bufferMs: null,
  silentSource: false,
  concealmentEvents: 0,
  implementation: 'MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT)',
  powerEfficient: true,
  fmtp: 'level-idx=5;profile=0;tier=0',
  scalabilityMode: 'L1T3',
};
vi.mock('../media/diagnostics', () => ({
  StatsSampler: class {
    sample = async (track: { video?: boolean }) => [track?.video ? camera : music];
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
      videoPaused: new Store({}),
      videoPauseCount: new Store(0),
      playoutTargets: () => [{ kind: 'media', targetMs: 600 }],
      returnToLive: vi.fn(),
      codecInfo: (source: string) =>
        source === 'camera'
          ? {
              decision: {
                source: 'camera',
                codec: 'av1',
                hw: true,
                scalabilityMode: 'L1T3',
                simulcast: false,
                backup: 'h264',
                backupActive: true,
                reason: 'hardware',
                skipped: [],
              },
              fallbacks: 1,
              switches: 2,
              pending: false,
            }
          : null,
      callReport: () => ({
        seconds: 312,
        rttMs: 57,
        lossPercent: 0.2,
        jitterMs: 4,
        bitrateKbps: 160,
        freezes: 0,
        freezeSeconds: 0,
        lossySeconds: 0,
        path: 'direct-udp',
        codec: 'vp9',
      }),
    },
    control: { state: new Store('connected') },
  } as unknown as Meeting;
}

describe('«Диагностика»', () => {
  it('без подзаголовка (R47): сразу проверка устройств, сеть и подробности', () => {
    render(<Diagnostics meeting={fakeMeeting()} onClose={vi.fn()} onHelp={vi.fn()} onReport={vi.fn()} />);
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
        onReport={vi.fn()}
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
      'Звук отправителя',
      'Пропуски звука за секунду',
    ]);
    const card = within(track.closest('article')!);
    expect(card.getByText('160 Кбит/с')).toBeVisible();
    // R09, R29: тишина издателя — не «нет пакетов», а слова о том, что у отправителя пауза.
    expect(card.getByText('Тишина — у отправителя пауза или он не успевает')).toBeVisible();
    expect(card.getByText('3')).toBeVisible();
  });

  it('«Скопировать отчёт о звонке» кладёт в буфер числа звонка и дорожек — без имён (R29)', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <Diagnostics
        meeting={fakeMeeting([{ name: 'Аня Петрова', track: {} }])}
        onClose={vi.fn()}
        onHelp={vi.fn()}
        onReport={vi.fn()}
      />,
    );
    // Карточки рождаются из опроса статистики — на занятом раннере CI дольше секунды по умолчанию.
    await screen.findByRole(
      'heading',
      { name: 'Аня Петрова · Аудио · Получение', level: 4 },
      { timeout: 5000 },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Скопировать отчёт о звонке' }));
    expect(await screen.findByText('Отчёт скопирован — его можно вставить в обращение')).toBeVisible();
    const text = writeText.mock.calls[0]![0];
    expect(text).toMatch(/^cord: /);
    expect(text).toContain('call: 312 s');
    expect(text).toContain('playout: media 600 ms');
    expect(text).toContain('track: audio receive · 160 kbps · loss 0.0% · rtt 57 ms · buffer 640 ms');
    expect(text).toContain('concealment 3 · silent source');
    expect(text).not.toContain('Аня');
  });

  it('паузы видео от SFU (R117): сколько раз за встречу — в «Сети» и в отчёте; без пауз — ни слова', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const meeting = fakeMeeting();
    const { media } = meeting as unknown as {
      media: { videoPaused: Store<Record<string, true>>; videoPauseCount: Store<number> };
    };
    render(<Diagnostics meeting={meeting} onClose={vi.fn()} onHelp={vi.fn()} onReport={vi.fn()} />);
    expect(screen.queryByText(/Видео у вас приостанавливалось/)).toBeNull();
    act(() => {
      media.videoPauseCount.set(2);
      media.videoPaused.set({ TR_cam: true });
    });
    const note = screen.getByText(
      'Видео у вас приостанавливалось 2 раза: канал не тянул картинку, и сервер сберёг речь и музыку. Картинка возвращается сама, когда связь выправляется.',
    );
    // Пауза идёт прямо сейчас — предупреждение; кончилась — остаётся спокойной справкой.
    expect(note).toHaveAttribute('data-tone', 'warning');
    act(() => media.videoPaused.set({}));
    expect(note).not.toHaveAttribute('data-tone');
    fireEvent.click(screen.getByRole('button', { name: 'Скопировать отчёт о звонке' }));
    await screen.findByText('Отчёт скопирован — его можно вставить в обращение');
    expect(writeText.mock.calls[0]![0]).toContain('video paused by sfu: 2');
  });

  it('подвал: «Сообщить о проблеме» и «Поддержка» — окно заменяет тот, кто показал диагностику (R49, R79)', () => {
    const onHelp = vi.fn();
    const onReport = vi.fn();
    render(<Diagnostics meeting={fakeMeeting()} onClose={vi.fn()} onHelp={onHelp} onReport={onReport} />);
    fireEvent.click(screen.getByRole('button', { name: 'Поддержка' }));
    expect(onHelp).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Сообщить о проблеме' }));
    expect(onReport).toHaveBeenCalledTimes(1);
  });
  it('своя камера (R152): профиль, слои, железо и почему этот кодек — в карточке и в отчёте', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <Diagnostics
        meeting={fakeMeeting([{ name: 'Я', track: { video: true }, source: 'camera', local: true }])}
        onClose={vi.fn()}
        onHelp={vi.fn()}
        onReport={vi.fn()}
      />,
    );
    const track = await screen.findByRole(
      'heading',
      { name: 'Я · Видео · Передача', level: 4 },
      { timeout: 5000 },
    );
    const card = within(track.closest('article')!);
    expect(card.getByText('level-idx=5;profile=0;tier=0')).toBeVisible();
    expect(card.getByText('L1T3')).toBeVisible();
    expect(
      card.getByText('аппаратный · MediaFoundationVideoEncodeAccelerator (NVIDIA AV1 Encoder MFT)'),
    ).toBeVisible();
    expect(
      card.getByText('Лучший аппаратный на этой машине · рядом H.264 для зрителей без этого кодека'),
    ).toBeVisible();
    expect(card.getByText('Отступов сторожа: 1 · всего смен: 2')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Скопировать отчёт о звонке' }));
    await screen.findByText('Отчёт скопирован — его можно вставить в обращение');
    const text = writeText.mock.calls[0]![0];
    expect(text).toContain(
      'codec camera: av1 hw · L1T3 · single · backup h264 active · reason hardware · fallbacks 1 · switches 2',
    );
    expect(text).toContain(
      'video/AV1 · level-idx=5;profile=0;tier=0 · L1T3 · hw · MediaFoundationVideoEncodeAccelerator',
    );
    expect(text).toContain('encode 3.2 ms');
  });
});
