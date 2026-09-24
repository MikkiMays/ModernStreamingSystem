import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CinemaAt, CinemaItem, ProviderId } from '../../../core/cinema';
import { useKeyed, useStack, type View } from './useStack';

const VIDEO = { provider: 'youtube', kind: 'video', id: 'v1', title: 'Ролик' } as CinemaItem;
const at = (stack: View[]) => stack.map((view) => (view.at === 'channel' ? `channel:${view.tab}` : view.at));

describe('useStack: как ходят по каталогу', () => {
  it('начинает с главной, а каждый переход кладётся сверху', () => {
    const { result } = renderHook(() => useStack('youtube'));
    expect(at(result.current.stack)).toEqual(['home']);
    expect(result.current.view).toEqual({ at: 'home' });

    act(() => result.current.go({ at: 'playlist', id: 'PL1' }));
    act(() => result.current.go({ at: 'item', item: VIDEO }));
    expect(at(result.current.stack)).toEqual(['home', 'playlist', 'item']);
    expect(result.current.view).toEqual({ at: 'item', item: VIDEO });
  });

  it('канал открывается на вкладке «Видео»', () => {
    const { result } = renderHook(() => useStack('youtube'));
    act(() => result.current.toChannel('UC1'));
    expect(result.current.view).toEqual({ at: 'channel', id: 'UC1', tab: 'videos' });
  });

  it('«назад» снимает верхнее, а с главной не уводит никуда', () => {
    const { result } = renderHook(() => useStack('youtube'));
    act(() => result.current.toChannel('UC1'));
    act(() => result.current.go({ at: 'playlist', id: 'PL1' }));

    act(() => result.current.back());
    expect(at(result.current.stack)).toEqual(['home', 'channel:videos']);
    act(() => result.current.back());
    expect(at(result.current.stack)).toEqual(['home']);
    const before = result.current.stack;
    act(() => result.current.back());
    // Та же стопка, а не её копия: нажатие, которое ничего не меняет, и не рисует заново.
    expect(result.current.stack).toBe(before);
  });

  it('вкладки канала меняют верхнее: пять вкладок — одно «назад»', () => {
    const { result } = renderHook(() => useStack('youtube'));
    act(() => result.current.go({ at: 'item', item: VIDEO }));
    act(() => result.current.toChannel('UC1'));
    for (const tab of ['streams', 'shorts', 'playlists', 'about', 'videos'] as const)
      act(() => result.current.switchTab(tab));
    act(() => result.current.switchTab('playlists'));
    expect(at(result.current.stack)).toEqual(['home', 'item', 'channel:playlists']);
    expect(result.current.view).toEqual({ at: 'channel', id: 'UC1', tab: 'playlists' });

    act(() => result.current.back());
    expect(at(result.current.stack)).toEqual(['home', 'item']);
  });

  it('вкладка не трогает страницу, которая не канал', () => {
    const { result } = renderHook(() => useStack('youtube'));
    act(() => result.current.go({ at: 'playlist', id: 'PL1' }));
    act(() => result.current.switchTab('about'));
    expect(result.current.view).toEqual({ at: 'playlist', id: 'PL1' });
  });

  it('сезоны сериала меняют верхнее, как вкладки канала: три сезона — одно «назад»', () => {
    const { result } = renderHook(() => useStack('rutube'));
    act(() => result.current.go({ at: 'series', id: '891161', season: '', title: 'Универ', poster: null }));
    for (const season of ['2', '3', '1']) act(() => result.current.switchSeason(season));
    expect(at(result.current.stack)).toEqual(['home', 'series']);
    expect(result.current.view).toMatchObject({ at: 'series', id: '891161', season: '1' });
    act(() => result.current.back());
    expect(at(result.current.stack)).toEqual(['home']);
  });

  it('сезон не трогает страницу, которая не сериал', () => {
    const { result } = renderHook(() => useStack('rutube'));
    act(() => result.current.toChannel('23460655'));
    act(() => result.current.switchSeason('2'));
    expect(result.current.view).toEqual({ at: 'channel', id: '23460655', tab: 'videos' });
  });

  it('набранный поиск возвращает на главную, откуда бы его ни набрали', () => {
    const { result } = renderHook(() => useStack('youtube'));
    act(() => result.current.toChannel('UC1'));
    act(() => result.current.go({ at: 'playlist', id: 'PL1' }));
    act(() => result.current.home());
    expect(at(result.current.stack)).toEqual(['home']);
    expect(result.current.view).toEqual({ at: 'home' });
  });

  it('другая площадка начинает с главной в том же кадре, что её открыл', () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ owner }) => {
        const stack = useStack(owner);
        seen.push(`${owner}:${at(stack.stack).join('>')}`);
        return stack;
      },
      { initialProps: { owner: 'youtube' as ProviderId } },
    );
    act(() => result.current.toChannel('UC1'));
    seen.length = 0;

    rerender({ owner: 'twitch' });
    expect(at(result.current.stack)).toEqual(['home']);
    // Ни один рендер новой площадки не видел стопку старой — даже промежуточный.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((line) => line === 'twitch:home')).toBe(true);
  });

  it('возврат на прежнюю площадку тоже начинается с главной, а не с брошенной там стопки', () => {
    const { result, rerender } = renderHook(({ owner }) => useStack(owner), {
      initialProps: { owner: 'youtube' as ProviderId },
    });
    act(() => result.current.toChannel('UC1'));
    rerender({ owner: 'twitch' });
    rerender({ owner: 'youtube' });
    expect(at(result.current.stack)).toEqual(['home']);
  });
});

describe('useKeyed: состояние площадки', () => {
  it('ведёт себя как useState, пока ключ тот же', () => {
    const { result } = renderHook(() => useKeyed('youtube', ''));
    act(() => result.current[1]('big buck bunny'));
    expect(result.current[0]).toBe('big buck bunny');
    act(() => result.current[1]((value) => `${value}!`));
    expect(result.current[0]).toBe('big buck bunny!');
  });

  it('с новым ключом отдаёт начальное значение сразу, без промежуточного кадра', () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ key }) => {
        const state = useKeyed(key, '');
        seen.push(`${key}:${state[0]}`);
        return state;
      },
      { initialProps: { key: 'youtube' } },
    );
    act(() => result.current[1]('big buck bunny'));
    seen.length = 0;
    rerender({ key: 'twitch' });
    expect(result.current[0]).toBe('');
    expect(seen.every((line) => line === 'twitch:')).toBe(true);

    // И записанное дальше принадлежит уже новому ключу.
    act(() => result.current[1]('пятничный стрим'));
    expect(result.current[0]).toBe('пятничный стрим');
  });

  it('запоздавший вызов прежней площадки в новую не пишет', () => {
    const { result, rerender } = renderHook(({ key }) => useKeyed(key, ''), {
      initialProps: { key: 'youtube' },
    });
    const late = result.current[1];
    rerender({ key: 'twitch' });
    // Таймер или ответ, заведённые ещё на YouTube, срабатывают уже на Twitch.
    act(() => late('big buck bunny'));
    act(() => late((value) => `${value}!`));
    expect(result.current[0]).toBe('');
    act(() => result.current[1]('пятничный стрим'));
    expect(result.current[0]).toBe('пятничный стрим');
  });

  it('и в следующий заход на ту же площадку тоже: YouTube → Twitch → YouTube', () => {
    const { result, rerender } = renderHook(({ key }) => useKeyed(key, ''), {
      initialProps: { key: 'youtube' },
    });
    act(() => result.current[1]('big buck bunny'));
    const late = result.current[1];
    rerender({ key: 'twitch' });
    rerender({ key: 'youtube' });
    expect(result.current[0]).toBe('');
    act(() => late('never gonna give you up'));
    expect(result.current[0]).toBe('');
  });

  it('стопка: запоздавший переход со старой площадки на новую не попадает', () => {
    const { result, rerender } = renderHook(({ owner }) => useStack(owner), {
      initialProps: { owner: 'youtube' as ProviderId },
    });
    const { toChannel, go } = result.current;
    rerender({ owner: 'twitch' });
    act(() => toChannel('UC1'));
    act(() => go({ at: 'item', item: VIDEO }));
    expect(at(result.current.stack)).toEqual(['home']);
  });
});

describe('useStack: страница по ссылке', () => {
  const ROLL: CinemaAt = { page: 'item', kind: 'video', id: 'dQw4w9WgXcQ' };

  it('сцена, открытая по ссылке, начинается с её страницы, а «назад» ведёт на главную', () => {
    const seen: string[] = [];
    const { result } = renderHook(() => {
      const stack = useStack('youtube', ROLL);
      seen.push(at(stack.stack).join('>'));
      return stack;
    });
    // Витрины не было ни одного кадра: страница по ссылке — с первого же.
    expect(seen.every((line) => line === 'home>item')).toBe(true);
    expect(result.current.view).toEqual({
      at: 'item',
      linked: true,
      item: expect.objectContaining({
        provider: 'youtube',
        kind: 'video',
        id: 'dQw4w9WgXcQ',
        title: 'Видео YouTube по ссылке',
      }),
    });
    act(() => result.current.back());
    expect(result.current.view).toEqual({ at: 'home' });
  });

  it('ссылка, вставленная в открытую сцену, кладётся сверху; та же страница второй раз — нет', () => {
    const { result, rerender } = renderHook(({ link }) => useStack('rutube', link), {
      initialProps: { link: null as CinemaAt | null },
    });
    act(() => result.current.toChannel('23460655'));
    rerender({ link: { page: 'series', kind: 'series', id: '356362' } });
    expect(at(result.current.stack)).toEqual(['home', 'channel:videos', 'series']);
    expect(result.current.view).toEqual({ at: 'series', id: '356362', season: '', title: '', poster: null });
    // Та же ссылка ещё раз — новый объект, но та же страница: «назад» не должен ходить по дублям.
    rerender({ link: { page: 'series', kind: 'series', id: '356362' } });
    expect(at(result.current.stack)).toEqual(['home', 'channel:videos', 'series']);
    rerender({ link: { page: 'channel', kind: 'channel', id: '23463954' } });
    expect(result.current.view).toEqual({ at: 'channel', id: '23463954', tab: 'videos' });
    rerender({ link: { page: 'playlist', kind: 'playlist', id: 'PL1' } });
    expect(at(result.current.stack)).toEqual([
      'home',
      'channel:videos',
      'series',
      'channel:videos',
      'playlist',
    ]);
    // Закрытая ссылка (`null`) и «По ссылке» (`link`) стопку не трогают.
    rerender({ link: null });
    rerender({ link: { page: 'link', url: 'https://example.com/' } });
    expect(at(result.current.stack)).toEqual([
      'home',
      'channel:videos',
      'series',
      'channel:videos',
      'playlist',
    ]);
  });

  it('ссылка на соседнюю площадку той же сцены: стопка новой площадки — главная и страница ссылки', () => {
    const { result, rerender } = renderHook(({ owner, link }) => useStack(owner, link), {
      initialProps: { owner: 'youtube' as ProviderId, link: null as CinemaAt | null },
    });
    act(() => result.current.toChannel('UC1'));
    rerender({ owner: 'twitch', link: { page: 'item', kind: 'channel', id: 'pesh' } });
    expect(at(result.current.stack)).toEqual(['home', 'item']);
    expect(result.current.view).toMatchObject({
      at: 'item',
      item: { provider: 'twitch', kind: 'channel', id: 'pesh', title: 'Эфир Twitch: pesh', live: true },
    });
  });
});
