import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CinemaItem } from '../../../core/cinema';
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
      { initialProps: { owner: 'youtube' } },
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
      initialProps: { owner: 'youtube' },
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
      initialProps: { owner: 'youtube' },
    });
    const { toChannel, go } = result.current;
    rerender({ owner: 'twitch' });
    act(() => toChannel('UC1'));
    act(() => go({ at: 'item', item: VIDEO }));
    expect(at(result.current.stack)).toEqual(['home']);
  });
});
