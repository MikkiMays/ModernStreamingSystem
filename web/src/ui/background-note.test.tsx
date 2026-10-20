import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../core/store';
import type { Meeting } from '../core/meeting';
import type { MicGap } from '../media/background';
import type { Platform } from '../media/platform';
import { ADVICE_DELAY_MS, BackgroundNote } from './BackgroundNote';

function fakeMeeting(platform: Platform, captured = true) {
  const media = {
    state: new Store({ status: 'connected', error: null as string | null }),
    captured: new Store(captured),
    micGap: new Store<MicGap | null>(null),
    platform,
  };
  return {
    meeting: {
      media,
      ended: new Store<string | null>(null),
      invite: new Store<string | null>(null),
    } as unknown as Meeting,
    media,
  };
}

const ANDROID: Platform = { os: 'android', mobile: true, standalone: false, app: false };
const IOS_HOME: Platform = { os: 'ios', mobile: true, standalone: true, app: false };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('честная подсказка о фоне', () => {
  it('Android: после подключения — что держит разговор; скрытая — не возвращается', () => {
    const { meeting } = fakeMeeting(ANDROID);
    const first = render(<BackgroundNote meeting={meeting} />);
    expect(screen.queryByRole('note')).toBeNull();
    act(() => vi.advanceTimersByTime(ADVICE_DELAY_MS));
    expect(screen.getByRole('note').textContent).toContain('использует микрофон');
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть подсказку' }));
    expect(screen.queryByRole('note')).toBeNull();
    first.unmount();
    render(<BackgroundNote meeting={meeting} />);
    act(() => vi.advanceTimersByTime(ADVICE_DELAY_MS));
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('iPhone «Домой»: предлагает Safari и ссылку, которую можно скопировать', () => {
    const { meeting } = fakeMeeting(IOS_HOME);
    render(<BackgroundNote meeting={meeting} />);
    act(() => vi.advanceTimersByTime(ADVICE_DELAY_MS));
    expect(screen.getByRole('note').textContent).toContain('откройте встречу в Safari');
    expect(screen.getByRole('button', { name: 'Скопировать ссылку' })).toBeTruthy();
  });

  it('без захвата микрофона — честно о том, что фон не защищён', () => {
    const { meeting } = fakeMeeting(ANDROID, false);
    render(<BackgroundNote meeting={meeting} />);
    act(() => vi.advanceTimersByTime(ADVICE_DELAY_MS));
    expect(screen.getByRole('note').textContent).toContain('Без доступа к микрофону');
  });

  it('по возвращении: когда телефон глушил микрофон — с и до', () => {
    const { meeting, media } = fakeMeeting(ANDROID);
    render(<BackgroundNote meeting={meeting} />);
    const from = new Date(2026, 9, 20, 12, 3).getTime();
    const to = new Date(2026, 9, 20, 12, 7).getTime();
    act(() => media.micGap.set({ from, to }));
    expect(screen.getByRole('status').textContent).toContain('вас не слышали с 12:03 до 12:07');
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть подсказку' }));
    expect(media.micGap.get()).toBeNull();
  });

  it('ПК — подсказки нет', () => {
    const { meeting } = fakeMeeting({ os: 'other', mobile: false, standalone: false, app: false });
    render(<BackgroundNote meeting={meeting} />);
    act(() => vi.advanceTimersByTime(ADVICE_DELAY_MS));
    expect(screen.queryByRole('note')).toBeNull();
  });
});
