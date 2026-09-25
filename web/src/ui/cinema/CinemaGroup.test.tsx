import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { json, sceneMeeting } from '../../test/cinemaMeeting';
import { CinemaGroup } from './CinemaGroup';

/*
  Плитки «Кинозала» — реестр ∩ ответ службы.

  На установке с `CINEMA_PROVIDERS` выключенная площадка стояла обычной плиткой, и каждая её кнопка
  отвечала «Эта площадка выключена на этом сервере»; а причина недоступной площадки жила только во
  всплывающей подсказке, которую телефон не показывает никогда.
*/

const FEATURES = {
  search: true,
  channels: false,
  playlists: false,
  categories: false,
  series: false,
  live: false,
};
const entry = (id: string, available = true, reason: string | null = null) => ({
  id,
  available,
  reason,
  account: 'none',
  connected: false,
  features: FEATURES,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(answer: () => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(answer));
  const meeting = sceneMeeting('youtube');
  meeting.cinema.set(null);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CinemaGroup meeting={meeting} onBack={() => {}} />
    </QueryClientProvider>,
  );
  return meeting;
}

/** Плитки по порядку: имя и строка под ним. */
const tiles = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('.service-tile')).map((tile) => ({
    name: tile.querySelector('b')?.textContent,
    note: tile.querySelector('small')?.textContent,
    disabled: tile.disabled,
  }));

it('выключенной на сервере площадки нет, а причина недоступной — строкой на плитке, а не подсказкой', async () => {
  mount(() =>
    json({
      providers: [
        entry('youtube'),
        entry('rutube'),
        entry('vk'),
        entry('ivi', false, 'ivi отдаёт бесплатное только в России'),
        entry('link'),
      ],
    }),
  );
  await waitFor(() => expect(tiles()).toHaveLength(5));
  expect(tiles()).toEqual([
    { name: 'YouTube', note: 'Ролики, фильмы и каналы', disabled: false },
    { name: 'Rutube', note: 'Эфиры ТВ, сериалы и шоу', disabled: false },
    { name: 'VK Видео', note: 'Разделы, сообщества и эфиры', disabled: false },
    { name: 'ivi', note: 'ivi отдаёт бесплатное только в России', disabled: true },
    { name: 'По ссылке', note: 'Ролик, эфир или плейлист по ссылке', disabled: false },
  ]);
  // Причина — видимый текст самой плитки, а не `title`, который палец не покажет.
  const ivi = screen.getByRole('button', { name: /ivi/ });
  expect(within(ivi).getByText('ivi отдаёт бесплатное только в России')).toBeVisible();
  expect(ivi).not.toHaveAttribute('title');
  expect(screen.queryByText('Twitch')).toBeNull();
});

it('служба не ответила — все шесть площадок, как до проверки', async () => {
  const meeting = mount(() => Promise.resolve(new Response('{}', { status: 502 })));
  await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  await new Promise((done) => setTimeout(done, 50));
  expect(tiles().map((tile) => tile.name)).toEqual([
    'YouTube',
    'Twitch',
    'Rutube',
    'VK Видео',
    'ivi',
    'По ссылке',
  ]);
  expect(tiles().every((tile) => !tile.disabled)).toBe(true);
  screen.getByRole('button', { name: /Twitch/ }).click();
  expect(meeting.openCinema).toHaveBeenCalledWith('twitch');
});

it('служба назвала пустой список — плиток нет, и сказано почему', async () => {
  mount(() => json({ providers: [] }));
  expect(await screen.findByText('Площадки кинозала на этом сервере выключены.')).toBeVisible();
  expect(tiles()).toEqual([]);
});
