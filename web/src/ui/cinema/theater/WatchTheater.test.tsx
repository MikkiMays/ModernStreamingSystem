import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Watch } from '../../../api/types';
import type { CinemaSource } from '../../../core/cinema';
import type { Meeting } from '../../../core/meeting';
import { Store } from '../../../core/store';
import WatchTheater from './WatchTheater';

/*
  Готовый файл и обновление подписи — через настоящий `<video>` и его `error`.

  Подпись адреса поменялась вместе со службой (задача 4): после выкатки уже открытый файл
  отвечал 403 и стоял на «Поток не открылся» до перезагрузки. HLS и DASH переживали это и
  раньше — им об отказе говорит движок, а у файла движка нет, есть только сам `<video>`.
*/

const WATCH: Watch = {
  provider: 'youtube',
  kind: 'video',
  contentId: 'aqz-KE-bpKQ',
  title: 'Big Buck Bunny',
  openedBy: 'someone',
  paused: true,
  positionMs: 0,
  anchorAt: 0,
  revision: 1,
};

const file = (url: string): CinemaSource => ({
  provider: 'youtube',
  contentId: 'aqz-KE-bpKQ',
  title: 'Big Buck Bunny',
  author: 'Blender',
  duration: 635,
  live: false,
  kind: 'file',
  url,
  expiresAt: Date.now() + 5 * 3600 * 1000,
  notice: 'Доступен только готовый файл: качество ограничено источником',
  language: 'en',
  captions: [],
  poster: null,
});

/** Что спросили у `resolve` и что он ответит — по очереди. */
const asked: Record<string, unknown>[] = [];
let answers: CinemaSource[] = [];

function meeting() {
  return {
    admission: { participantId: 'me', roomId: 'room', credential: 'token' },
    snapshot: new Store({
      participants: [{ id: 'me', owner: true, name: 'Майс' }],
      integrationsAllowed: true,
    }),
    media: {
      preferences: new Store({ watchVolume: 70, watchAudio: '', watchSubtitles: '' }),
      saveSettings: vi.fn(),
      report: vi.fn(),
    },
    serverNow: () => Date.now(),
    command: vi.fn(() => Promise.resolve()),
  } as unknown as Meeting;
}

beforeEach(() => {
  asked.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      if (!new URL(input, 'http://test').pathname.endsWith('/cinema/resolve'))
        return Promise.resolve(new Response('{}', { status: 404 }));
      asked.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(
        new Response(JSON.stringify(answers.shift()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
  // В jsdom у `<video>` нет медиа: загрузка и воспроизведение — пустые.
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('файл, переставший открываться, получает одну новую подпись, а вторая ошибка — прежний отказ', async () => {
  answers = [file('/cinema/fetch?sig=old'), file('/cinema/fetch?sig=new')];
  const { container } = render(<WatchTheater meeting={meeting()} watch={WATCH} />);
  const video = container.querySelector('video')!;
  await waitFor(() => expect(video.getAttribute('src')).toBe('/cinema/fetch?sig=old'));
  expect(screen.getByText('Доступен только готовый файл: качество ограничено источником')).toBeVisible();

  fireEvent.error(video);
  await waitFor(() => expect(video.getAttribute('src')).toBe('/cinema/fetch?sig=new'));
  expect(asked).toEqual([
    { provider: 'youtube', contentId: 'aqz-KE-bpKQ', kind: 'video', adaptive: false },
    { provider: 'youtube', contentId: 'aqz-KE-bpKQ', kind: 'video', adaptive: false, refresh: true },
  ]);
  // Пока адрес обновляется, человек видит «Открываем…», а не отказ.
  expect(screen.getByText('Открываем…')).toBeVisible();
  expect(screen.queryByText('Поток не открылся. Попробуйте другое видео')).toBeNull();

  fireEvent.error(video);
  expect(await screen.findByText('Поток не открылся. Попробуйте другое видео')).toBeVisible();
  expect(asked).toHaveLength(2);
});

it('отказ остаётся своими словами: ошибка `<video>` после неудачного обновления его не переписывает', async () => {
  answers = [file('/cinema/fetch?sig=old')];
  const { container } = render(<WatchTheater meeting={meeting()} watch={WATCH} />);
  const video = container.querySelector('video')!;
  await waitFor(() => expect(video.getAttribute('src')).toBe('/cinema/fetch?sig=old'));
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(
      JSON.stringify({ detail: 'Комната открывает слишком много видео. Попробуйте через минуту' }),
      {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  );
  fireEvent.error(video);
  const refusal = 'Комната открывает слишком много видео. Попробуйте через минуту';
  expect(await screen.findByText(refusal)).toBeVisible();
  fireEvent.error(video);
  expect(screen.getByText(refusal)).toBeVisible();
  expect(screen.queryByText('Поток не открылся. Попробуйте другое видео')).toBeNull();
});

it('досмотрели: нажатие мышью по кадру включает ролик заново для всех, а не ставит паузу', async () => {
  answers = [file('/cinema/fetch?sig=old')];
  const room = meeting();
  // Комната не на паузе: её секунда давно ушла за конец ролика в 635 с, паузы никто не ставил.
  const { container } = render(
    <WatchTheater meeting={room} watch={{ ...WATCH, paused: false, anchorAt: Date.now() - 700_000 }} />,
  );
  const video = container.querySelector('video')!;
  await waitFor(() => expect(video.getAttribute('src')).toBe('/cinema/fetch?sig=old'));
  // Свой плеер — на последнем кадре.
  Object.defineProperty(video, 'ended', { configurable: true, value: true });
  Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 635 });
  // Проверка раз в секунду замечает конец.
  await act(() => new Promise((done) => setTimeout(done, 1100)));
  fireEvent.click(video);
  expect(room.command).toHaveBeenCalledWith('watch.play', undefined, undefined, { positionMs: 0 });
  expect(room.command).not.toHaveBeenCalledWith('watch.pause', undefined, undefined, expect.anything());
  expect(video.currentTime).toBe(0);
});
