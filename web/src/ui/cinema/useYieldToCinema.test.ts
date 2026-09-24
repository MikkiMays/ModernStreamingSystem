import { useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Watch } from '../../api/types';
import type { ProviderId } from '../../core/cinema';
import type { Meeting } from '../../core/meeting';
import { Store } from '../../core/store';
import type { Panel } from '../Sidebar';
import { useYieldToCinema } from './useYieldToCinema';

/*
  Кто и когда закрывает панель встречи ради кинозала.

  Ширина экрана подделывается целиком: `matchMedia` отвечает по настоящему разбору
  `min-width`/`max-width` и рассылает `change`, когда ширину меняют, — так проверяется и то,
  что от одной только смены ширины панель не закрывается.
*/

let width = 900;
const lists: { query: string; listeners: Set<() => void> }[] = [];
function matches(query: string) {
  const min = /min-width:\s*(\d+)px/.exec(query);
  const max = /max-width:\s*(\d+)px/.exec(query);
  return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
}
function resize(next: number) {
  width = next;
  for (const list of lists) for (const listener of list.listeners) listener();
}

beforeEach(() => {
  width = 900;
  lists.length = 0;
  vi.stubGlobal('matchMedia', (query: string) => {
    const list = { query, listeners: new Set<() => void>() };
    lists.push(list);
    return {
      get matches() {
        return matches(query);
      },
      addEventListener: (_: string, listener: () => void) => list.listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => list.listeners.delete(listener),
    };
  });
});
afterEach(() => vi.unstubAllGlobals());

const film = (openedBy: string, contentId: string, revision = 1) =>
  ({ provider: 'youtube', kind: 'video', contentId, openedBy, revision, paused: false }) as Watch;

function mount(panel: Panel | null) {
  const cinema = new Store<ProviderId | null>(null);
  const snapshot = new Store<{ watch: Watch | null }>({ watch: null });
  const meeting = { admission: { participantId: 'me' }, cinema, snapshot } as unknown as Meeting;
  const view = renderHook(() => {
    const [open, setOpen] = useState<Panel | null>(panel);
    useYieldToCinema(meeting, setOpen);
    return { open, setOpen };
  });
  const start = (watch: Watch | null) => act(() => snapshot.set({ watch }));
  const browse = (provider: ProviderId | null) => act(() => cinema.set(provider));
  return { view, start, browse };
}

describe('фильм', () => {
  it('включённый другим, не закрывает ничего: ни чат, ни интеграции, ни людей', () => {
    for (const panel of ['chat', 'services', 'people'] as const) {
      const { view, start } = mount(panel);
      start(film('other', 'dQw4w9WgXcQ'));
      expect(view.result.current.open).toBe(panel);
    }
  });

  it('включённый мной, закрывает любую панель: сцену попросил я', () => {
    for (const panel of ['chat', 'services', 'people'] as const) {
      const { view, start } = mount(panel);
      start(film('me', 'dQw4w9WgXcQ'));
      expect(view.result.current.open).toBeNull();
    }
  });

  it('следующий мой фильм закрывает панель снова, а пауза и перемотка — нет', () => {
    const { view, start } = mount('services');
    start(film('me', 'dQw4w9WgXcQ'));
    act(() => view.result.current.setOpen('chat'));
    // Пауза, перемотка — та же площадка и тот же ролик, только новая ревизия.
    start(film('me', 'dQw4w9WgXcQ', 2));
    start(film('me', 'dQw4w9WgXcQ', 3));
    expect(view.result.current.open).toBe('chat');

    start(film('me', 'aqz-KE-bpKQ', 4));
    expect(view.result.current.open).toBeNull();
  });

  it('чужой фильм между моими не считается моим, а мой после него — считается', () => {
    const { view, start } = mount('services');
    start(film('me', 'dQw4w9WgXcQ'));
    act(() => view.result.current.setOpen('chat'));
    start(film('other', 'aqz-KE-bpKQ'));
    expect(view.result.current.open).toBe('chat');
    start(film('me', 'dQw4w9WgXcQ'));
    expect(view.result.current.open).toBeNull();
  });

  it('на широком экране не закрывает ничего: кинозал отодвигается от полосы сам', () => {
    width = 1100;
    for (const panel of ['chat', 'services'] as const) {
      const { view, start } = mount(panel);
      start(film('me', 'dQw4w9WgXcQ'));
      expect(view.result.current.open).toBe(panel);
    }
  });

  it('смена ширины — не действие: панель, открытая во время моего фильма, остаётся', () => {
    width = 1100;
    const { view, start } = mount('chat');
    start(film('me', 'dQw4w9WgXcQ'));
    act(() => resize(900));
    act(() => resize(390));
    expect(view.result.current.open).toBe('chat');
  });
});

describe('каталог', () => {
  it('открытый мной, закрывает любую панель на телефоне и на планшете', () => {
    for (const screen of [390, 720, 760, 768, 900, 959])
      for (const panel of ['chat', 'services', 'people'] as const) {
        width = screen;
        const { view, browse } = mount(panel);
        browse('youtube');
        expect(view.result.current.open).toBeNull();
      }
  });

  it('с 960 px панель остаётся: кинозал встаёт рядом с ней', () => {
    for (const screen of [960, 1100, 1440]) {
      width = screen;
      const { view, browse } = mount('chat');
      browse('youtube');
      expect(view.result.current.open).toBe('chat');
    }
  });

  it('открытый каталог не закрывает панель, открытую после него, пока его не откроют снова', () => {
    const { view, browse } = mount('services');
    browse('youtube');
    act(() => view.result.current.setOpen('chat'));
    act(() => resize(760));
    expect(view.result.current.open).toBe('chat');
    // Другая площадка — снова своё действие.
    browse('twitch');
    expect(view.result.current.open).toBeNull();
  });

  it('закрытие каталога — не открытие: панель после него остаётся', () => {
    const { view, browse } = mount('services');
    browse('youtube');
    act(() => view.result.current.setOpen('chat'));
    browse(null);
    expect(view.result.current.open).toBe('chat');
  });
});
