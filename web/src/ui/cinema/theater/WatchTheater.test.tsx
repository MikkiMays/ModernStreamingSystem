import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Watch } from '../../../api/types';
import type { CinemaSource } from '../../../core/cinema';
import type { Meeting } from '../../../core/meeting';
import { Store } from '../../../core/store';
import theaterCss from '../theater.css?raw';
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
/** Что служба ответит на страницу серии (`details`); `null` — 404. */
let detailsAnswer: unknown = null;

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
  detailsAnswer = null;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const path = new URL(input, 'http://test').pathname;
      if (path.endsWith('/cinema/details') && detailsAnswer)
        return Promise.resolve(
          new Response(JSON.stringify(detailsAnswer), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      if (!path.endsWith('/cinema/resolve')) return Promise.resolve(new Response('{}', { status: 404 }));
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

/** Открыть файл и дождаться, пока плеер готов: метаданные пришли, длительность известна. */
async function ready(watch: Watch, room = meeting()) {
  answers = [file('/cinema/fetch?sig=old')];
  const view = render(<WatchTheater meeting={room} watch={watch} />);
  const video = view.container.querySelector('video')!;
  await waitFor(() => expect(video.getAttribute('src')).toBe('/cinema/fetch?sig=old'));
  Object.defineProperty(video, 'duration', { configurable: true, value: 635 });
  fireEvent.loadedMetadata(video);
  const theater = view.container.querySelector<HTMLElement>('.watch-theater')!;
  const chrome = view.container.querySelector<HTMLElement>('.watch-chrome')!;
  return { room, video, theater, chrome };
}

/*
  T19: «убирать курсор и ленту плеера снизу при просмотре». Через две с половиной секунды без
  движения уходят курсор (`data-idle` на всём плеере) и пульт вместе с нижней полосой; движение мыши
  возвращает их.
*/
it('через 2,5 с без движения плеер спит: курсор и пульт с нижней лентой уходят, движение их возвращает', async () => {
  const { theater, chrome } = await ready(WATCH);
  // Последнее движение — сейчас: отсчёт бездействия начинается от него.
  fireEvent.pointerMove(theater);
  expect(chrome).toHaveAttribute('data-shown', 'true');
  await act(() => new Promise((done) => setTimeout(done, 2600)));
  expect(theater).toHaveAttribute('data-idle', 'true');
  expect(chrome).not.toHaveAttribute('data-shown');
  fireEvent.pointerMove(theater);
  expect(theater).not.toHaveAttribute('data-idle');
  expect(chrome).toHaveAttribute('data-shown', 'true');
});

/*
  Почему «лента снизу» не уходила: правило `.watch-chrome:focus-within` держало пульт видимым, пока
  фокус стоит на кнопке, — а после нажатия мышью он там и стоит. Пульт клавиатуре достаётся фокусом
  Tab (он будит плеер, как движение мыши), а не правилом CSS, которое не отпускает его никогда.
*/
it('фокус, оставшийся на кнопке после нажатия мышью, пульт на кадре не держит', () => {
  expect(theaterCss).not.toMatch(/\.watch-chrome:focus-within/);
});

/*
  T20: клавиши плеера. Пауза и перемотка — общие, той же командой комнате, что кнопки пульта.
*/
it('пробел включает для всех, стрелка вправо — перемотка на 10 с для всех, стрелка вверх — своя громкость', async () => {
  const { room } = await ready(WATCH);
  fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
  expect(room.command).toHaveBeenCalledWith('watch.play', undefined, undefined, { positionMs: 0 });
  // Отправка в комнату одна за раз: следующая — когда прежняя дошла.
  await act(() => new Promise((done) => setTimeout(done, 0)));
  fireEvent.keyDown(document.body, { key: 'ArrowRight', code: 'ArrowRight' });
  expect(room.command).toHaveBeenCalledWith('watch.seek', undefined, undefined, { positionMs: 10_000 });
  expect(document.querySelector('.watch-hint')).toHaveTextContent('+10 с');
  fireEvent.keyDown(document.body, { key: 'ArrowUp', code: 'ArrowUp' });
  expect(room.media.saveSettings).toHaveBeenCalledWith({ watchVolume: 75 });
});

it('без права на пульт клавиша паузы не шлёт ничего и говорит почему; в поле ввода клавиши не плеера', async () => {
  const room = meeting();
  room.snapshot.set({
    ...room.snapshot.get(),
    participants: [{ id: 'me', owner: false, name: 'Гость' }],
    integrationsAllowed: false,
  } as never);
  await ready(WATCH, room);
  fireEvent.keyDown(document.body, { key: ' ', code: 'Space' });
  expect(room.command).not.toHaveBeenCalled();
  expect(document.querySelector('.watch-hint')).toHaveTextContent(
    'Ведущий разрешил пульт только себе — пауза и перемотка у него',
  );

  const field = document.createElement('input');
  document.body.append(field);
  fireEvent.keyDown(field, { key: 'ArrowUp', code: 'ArrowUp' });
  expect(room.media.saveSettings).not.toHaveBeenCalledWith({ watchVolume: expect.any(Number) });
  field.remove();
});

/*
  T17: «следующая серия». Серия по ссылке досмотрена — плеер спрашивает её страницу и предлагает
  следующую; кнопка включает её всей комнате (`watch.open`), как «Смотреть вместе» в каталоге.
*/
it('досмотрели серию по ссылке — «Включить следующую для всех» открывает следующую серию комнате', async () => {
  const id = 'Qm9vay1vZi1saW5rLTAwMQ';
  const nextId = 'RXBpc29kZS1ieS1saW5rLTA';
  detailsAnswer = {
    provider: 'link',
    kind: 'video',
    id,
    title: 'Финал сезона',
    author: '',
    duration: 635,
    live: false,
    description: '',
    poster: null,
    series: 'U2Vhc29uZWQtc2hvdy0wMDE',
    next: {
      provider: 'link',
      kind: 'video',
      id: nextId,
      title: 'Начало второго сезона',
      author: '',
      duration: 1510,
      live: false,
      poster: null,
      badge: '1 серия',
    },
  };
  answers = [{ ...file('/cinema/fetch?sig=old'), provider: 'link', contentId: id }];
  const room = meeting();
  const { container } = render(
    <WatchTheater
      meeting={room}
      watch={{ ...WATCH, provider: 'link', contentId: id, paused: false, anchorAt: Date.now() - 700_000 }}
    />,
  );
  const video = container.querySelector('video')!;
  await waitFor(() => expect(video.getAttribute('src')).toBe('/cinema/fetch?sig=old'));
  Object.defineProperty(video, 'ended', { configurable: true, value: true });
  Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 635 });
  const play = await screen.findByRole('button', { name: /Включить следующую для всех/ }, { timeout: 5000 });
  expect(screen.getByText('Начало второго сезона')).toBeInTheDocument();
  fireEvent.click(play);
  expect(room.command).toHaveBeenCalledWith('watch.open', 'Начало второго сезона', undefined, {
    provider: 'link',
    kind: 'video',
    contentId: nextId,
  });
});
