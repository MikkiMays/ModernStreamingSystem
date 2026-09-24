import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Meeting } from '../../../core/meeting';
import type { ProviderId } from '../../../core/cinema';
import { Store } from '../../../core/store';
import SwitcherScene from './SwitcherScene';

/*
  Смена площадки — это смена всего, что было открыто: стопки, запроса и витрины.

  Раньше сброс делал эффект, то есть на кадр позже: первый кадр новой площадки ещё видел поиск
  и канал старой — и успевал спросить у службы «big buck bunny» на Twitch и канал YouTube под
  именем Twitch. Здесь это ловится по самим запросам: служба не должна услышать ни одного
  вопроса, в котором площадка одна, а содержимое — от другой.
*/

const VIDEO = {
  provider: 'youtube',
  kind: 'video',
  id: 'aqz-KE-bpKQ',
  title: 'Big Buck Bunny 60fps 4K',
  author: 'Blender',
  channelId: 'UCSMOQeBJ2RAnuFungnQOxLg',
  duration: 635,
  live: false,
  poster: null,
};

function answer(url: URL) {
  const endpoint = url.pathname.split('/cinema/')[1];
  if (endpoint === 'search')
    return url.searchParams.get('provider') === 'youtube' && url.searchParams.get('query')
      ? { items: [VIDEO], channels: [], categories: [], next: null }
      : { items: [], channels: [], categories: [], next: null };
  if (endpoint === 'channel') return { channel: null, items: [], next: null };
  return { items: [], next: null };
}

/** Что спросили у службы: `площадка endpoint запрос/id`. */
const asked: string[] = [];

beforeEach(() => {
  asked.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const url = new URL(input, 'http://test');
      const params = url.searchParams;
      asked.push(
        `${params.get('provider')} ${url.pathname.split('/cinema/')[1]} ${params.get('query') ?? params.get('id')}`,
      );
      return Promise.resolve(
        new Response(JSON.stringify(answer(url)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ meeting }: { meeting: Meeting }) {
  const [provider, setProvider] = useState<ProviderId>('youtube');
  return <SwitcherScene meeting={meeting} provider={provider} onProvider={setProvider} onClose={() => {}} />;
}

function mount() {
  const meeting = {
    admission: { roomId: 'room', participantId: 'self', credential: 'token' },
    snapshot: new Store({
      participants: [{ id: 'self', owner: true }],
      integrationsAllowed: true,
      watch: null,
    }),
    command: vi.fn(),
    openCinema: vi.fn(),
  } as unknown as Meeting;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness meeting={meeting} />
    </QueryClientProvider>,
  );
  return client;
}

async function search(text: string) {
  fireEvent.change(screen.getByPlaceholderText('Ролик, канал или плейлист'), { target: { value: text } });
  await waitFor(() => expect(asked).toContain(`youtube search ${text}`));
}

/** Нажать вкладку Twitch так, как это делает мышь: фокус на кнопку, потом нажатие. */
async function toTwitch() {
  const twitch = screen.getByRole('tab', { name: 'Twitch' });
  twitch.focus();
  await act(async () => fireEvent.click(twitch));
  await waitFor(() => expect(asked).toContain('twitch search '));
  return twitch;
}

it('новая площадка не наследует поиск: Twitch не спрашивают о запросе, набранном на YouTube', async () => {
  const client = mount();
  await search('big buck bunny');
  await screen.findByRole('button', { name: 'Blender' });

  const twitch = await toTwitch();
  expect(asked.filter((line) => line.startsWith('twitch '))).toEqual(['twitch search ']);
  expect(screen.getByPlaceholderText('Канал или игра на Twitch')).toHaveValue('');
  // Вкладки и поле — те же элементы, что и были: фокус остался на нажатой вкладке, а не уехал
  // в поле поиска с `autoFocus`, как было бы при пересоздании шапки.
  expect(document.activeElement).toBe(twitch);
  client.clear();
});

it('новая площадка не наследует стопку: канал YouTube не запрашивают у Twitch', async () => {
  const client = mount();
  await search('big buck bunny');
  fireEvent.click(await screen.findByRole('button', { name: 'Blender' }));
  await waitFor(() => expect(asked).toContain(`youtube channel ${VIDEO.channelId}`));
  expect(screen.getByRole('button', { name: 'Назад' })).toBeInTheDocument();

  const twitch = await toTwitch();
  expect(asked.filter((line) => line.startsWith('twitch '))).toEqual(['twitch search ']);
  expect(screen.queryByRole('button', { name: 'Назад' })).toBeNull();
  expect(document.activeElement).toBe(twitch);
  client.clear();
});
