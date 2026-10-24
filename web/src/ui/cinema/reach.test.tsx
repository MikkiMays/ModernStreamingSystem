import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import { CATALOG_TIMEOUT, retryCatalog, type ProviderId } from '../../core/cinema';
import type { Meeting } from '../../core/meeting';
import { i18next, t } from '../../i18n';
import en from '../../i18n/locales/en.json';
import { sceneMeeting } from '../../test/cinemaMeeting';
import { problemText } from './catalog/notes';
import { CinemaGroup } from './CinemaGroup';
import SwitcherScene from './scenes/SwitcherScene';

/*
  Площадка, до которой сервер не достаёт (R112): московский сервер не видит YouTube, и поиск висел
  «Спрашиваем площадку…» без конца. Теперь служба говорит об этом сама — в списке площадок
  (`code: CINEMA_UNREACHABLE`) и отказом сразу (503), — а каталог отмечает площадку, показывает отказ
  словами с «Повторить» и сам больше не ждёт дольше своего срока.
*/

const FEATURES = {
  search: true,
  channels: true,
  playlists: true,
  categories: true,
  series: false,
  live: true,
};
const UNREACHABLE = {
  code: 'CINEMA_UNREACHABLE',
  detail: 'YouTube недоступен с этого сервера',
  provider: 'youtube',
};

/** Какие площадки служба назовёт недоступными с этого сервера. */
let down: string[] = [];
/** Что служба ответит на поиск: обычную пустую ленту, отказ или ничего (`never`). */
let search: 'empty' | 'refused' | 'never' = 'empty';
/** Что служба ответит на ссылку. */
let link: 'route' | 'refused' = 'route';
const asked: string[] = [];

function respond(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );
}

beforeEach(() => {
  down = [];
  search = 'empty';
  link = 'route';
  asked.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://test');
      const endpoint = url.pathname.split('/cinema/')[1]!;
      asked.push(
        `${endpoint} ${url.searchParams.get('provider') ?? ''} ${url.searchParams.get('query') ?? ''}`,
      );
      if (endpoint === 'providers')
        return respond({
          providers: ['youtube', 'twitch', 'rutube', 'vk', 'ivi', 'link'].map((id) => ({
            id,
            available: !down.includes(id),
            reason: down.includes(id) ? 'YouTube недоступен с этого сервера' : null,
            ...(down.includes(id) ? { code: 'CINEMA_UNREACHABLE' } : {}),
            account: 'none',
            connected: false,
            features: FEATURES,
          })),
        });
      if (endpoint === 'link')
        return link === 'refused'
          ? respond(UNREACHABLE, 503)
          : respond({ route: { provider: 'youtube', kind: 'video', id: 'aqz-KE-bpKQ', page: 'item' } });
      if (endpoint === 'search' && url.searchParams.get('provider') === 'youtube') {
        if (search === 'refused') return respond(UNREACHABLE, 503);
        if (search === 'never')
          return new Promise((_resolve, reject) =>
            init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason as Error)),
          );
      }
      return respond({ items: [], channels: [], categories: [], next: null });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Клиент запросов как у приложения: один повтор по умолчанию, у кинозала — свои правила (`retryCatalog`). */
function client() {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
  queries.setQueryDefaults(['cinema'], { retry: retryCatalog, retryDelay: 0 });
  return queries;
}

function Harness({ meeting, start }: { meeting: Meeting; start: ProviderId }) {
  const [provider, setProvider] = useState<ProviderId>(start);
  return <SwitcherScene meeting={meeting} provider={provider} onProvider={setProvider} onClose={() => {}} />;
}

function scene(start: ProviderId = 'youtube') {
  const meeting = sceneMeeting(start);
  render(
    <QueryClientProvider client={client()}>
      <Harness meeting={meeting} start={start} />
    </QueryClientProvider>,
  );
  return meeting;
}

const searches = () => asked.filter((line) => line.startsWith('search youtube'));

describe('каталог отмечает площадку, до которой сервер не достаёт', () => {
  it('вкладка остаётся, но отмечена, и подсказка по наведению говорит причину', async () => {
    down = ['youtube'];
    scene('twitch');
    const tab = await screen.findByRole('tab', { name: /YouTube/ });
    await waitFor(() => expect(tab).toHaveAttribute('data-reach', 'down'));
    expect(tab).toHaveAttribute('title', 'YouTube недоступен с этого сервера');
    expect(tab).toHaveAccessibleDescription('YouTube недоступен с этого сервера');
    // Соседняя вкладка не отмечена: недоступна одна площадка, а не кинозал.
    expect(screen.getByRole('tab', { name: 'Twitch' })).not.toHaveAttribute('data-reach');
  });

  it('вместо витрины — что с площадкой и «Повторить»; у площадки ничего не спрашивают зря', async () => {
    down = ['youtube'];
    scene('youtube');
    const notice = await screen.findByText('YouTube недоступен с этого сервера', { selector: 'b' });
    expect(notice.closest('[role="status"]')).toHaveTextContent('Другие площадки работают как обычно');
    expect(searches()).toEqual([]);
    // Площадку починили — «Повторить» спрашивает службу снова, и витрина возвращается.
    down = [];
    const before = asked.filter((line) => line.startsWith('providers')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(asked.filter((line) => line.startsWith('providers')).length).toBe(before + 1));
    await waitFor(() => expect(screen.queryByText('YouTube недоступен с этого сервера')).toBeNull());
  });

  it('плитка в панели называет причину на языке человека, а не русскими словами службы', async () => {
    down = ['youtube'];
    const meeting = sceneMeeting('youtube');
    render(
      <QueryClientProvider client={client()}>
        <CinemaGroup meeting={meeting} onBack={() => {}} />
      </QueryClientProvider>,
    );
    const tile = await screen.findByRole('button', { name: /YouTube недоступен с этого сервера/ });
    expect(tile).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Twitch/ })).toBeEnabled();
  });
});

describe('поиск по недоступной площадке не висит', () => {
  it('отказ службы — словами и с «Повторить», а сам каталог его не повторяет', async () => {
    search = 'refused';
    scene('youtube');
    fireEvent.change(screen.getByPlaceholderText('Ролик, канал или плейлист'), { target: { value: 'кино' } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('YouTube недоступен с этого сервера');
    expect(screen.queryByText('Спрашиваем площадку…')).toBeNull();
    expect(searches()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(searches()).toHaveLength(2));
  });

  it('служба молчит — по сроку браузера «Сервер не ответил вовремя» и «Повторить», без второго ожидания', async () => {
    search = 'never';
    const clocks: AbortController[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      if (ms !== CATALOG_TIMEOUT) return timeout(ms);
      const clock = new AbortController();
      clocks.push(clock);
      return clock.signal;
    });
    scene('youtube');
    fireEvent.change(screen.getByPlaceholderText('Ролик, канал или плейлист'), { target: { value: 'кино' } });
    await screen.findByText('Спрашиваем площадку…');
    await waitFor(() => expect(searches()).toHaveLength(1));
    act(() => clocks.forEach((clock) => clock.abort(new DOMException('Срок вышел', 'TimeoutError'))));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Сервер не ответил вовремя — попробуйте ещё раз',
    );
    expect(screen.queryByText('Спрашиваем площадку…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
    expect(searches()).toHaveLength(1);
  });

  it('ссылка на ролик недоступной площадки — отказ сразу, там же, где её вставили', async () => {
    link = 'refused';
    const meeting = scene('youtube');
    const field = screen.getByPlaceholderText('Ролик, канал или плейлист');
    fireEvent.paste(field);
    fireEvent.change(field, { target: { value: 'https://youtu.be/aqz-KE-bpKQ' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('YouTube недоступен с этого сервера');
    expect(meeting.openCinema).not.toHaveBeenCalled();
    const links = () => asked.filter((line) => line.startsWith('link')).length;
    expect(links()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(links()).toBe(2));
  });
});

describe('слова отказа', () => {
  it('площадку называет по коду и имени из отказа, на языке человека', async () => {
    const refused = new ApiError(
      503,
      'CINEMA_UNREACHABLE',
      'YouTube недоступен с этого сервера',
      UNREACHABLE,
    );
    const late = new ApiError(504, 'CINEMA_TIMEOUT', 'VK Видео не ответил вовремя', {
      code: 'CINEMA_TIMEOUT',
      provider: 'vk',
    });
    expect(problemText(t, refused)).toBe('YouTube недоступен с этого сервера');
    expect(problemText(t, late)).toBe('VK Видео не ответил вовремя — попробуйте ещё раз');
    i18next.addResourceBundle('en', 'translation', en, true, true);
    await i18next.changeLanguage('en');
    try {
      expect(problemText(t, refused)).toBe("YouTube can't be reached from this server");
    } finally {
      await i18next.changeLanguage('ru');
    }
    // Незнакомая площадка в отказе — слова службы как есть.
    const stranger = new ApiError(503, 'CINEMA_UNREACHABLE', 'Vimeo недоступен', { provider: 'vimeo' });
    expect(problemText(t, stranger)).toBe('Vimeo недоступен');
  });

  it('сам каталог повторяет только мигнувшую сеть, а не недоступную площадку и не вышедший срок', () => {
    expect(retryCatalog(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(retryCatalog(1, new TypeError('Failed to fetch'))).toBe(false);
    expect(retryCatalog(0, new ApiError(502, 'REQUEST_FAILED', 'Площадка не ответила'))).toBe(true);
    expect(retryCatalog(0, new ApiError(503, 'CINEMA_UNREACHABLE', 'x'))).toBe(false);
    expect(retryCatalog(0, new ApiError(504, 'CINEMA_TIMEOUT', 'x'))).toBe(false);
    expect(retryCatalog(0, new DOMException('x', 'TimeoutError'))).toBe(false);
  });
});
