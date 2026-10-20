import { beforeEach, describe, expect, it } from 'vitest';
import {
  ONBOARDING_KEY,
  TOUR,
  markSeen,
  onboarding,
  readOnboarding,
  replayOnboarding,
  tourSteps,
} from './onboarding';

describe('onboarding', () => {
  beforeEach(() => {
    localStorage.clear();
    onboarding.set(readOnboarding());
  });

  it('a fresh device has seen nothing, and what it has seen stays seen', () => {
    expect(onboarding.get()).toEqual({ tour: false, meeting: false, integrations: false });
    markSeen('tour');
    expect(onboarding.get().tour).toBe(true);
    expect(JSON.parse(localStorage.getItem(ONBOARDING_KEY)!)).toMatchObject({ tour: true });
    // Перезапуск — то же устройство: прочитанное с диска совпадает.
    expect(readOnboarding()).toEqual({ tour: true, meeting: false, integrations: false });
  });

  it('«Пройти знакомство» shows everything again', () => {
    markSeen('tour');
    markSeen('meeting');
    markSeen('integrations');
    replayOnboarding();
    expect(onboarding.get()).toEqual({ tour: false, meeting: false, integrations: false });
    expect(readOnboarding().tour).toBe(false);
  });

  it('an unreadable record means a fresh device, not a crash', () => {
    localStorage.setItem(ONBOARDING_KEY, '{oops');
    expect(readOnboarding()).toEqual({ tour: false, meeting: false, integrations: false });
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify({ tour: 'yes', meeting: true }));
    expect(readOnboarding()).toEqual({ tour: false, meeting: true, integrations: false });
  });
});

describe('tourSteps', () => {
  it('walks the real buttons in order and stays within five steps', () => {
    const all = tourSteps(() => true);
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.length).toBeLessThanOrEqual(5);
    expect(all[0]).toBe('create');
    expect(TOUR).toContain('menu');
  });

  it('skips a step whose button is not on screen', () => {
    // Телефон: избранное, настройки и помощь — в меню под бургером, шаг ведёт к бургеру.
    const phone = tourSteps((id) => ['create', 'join', 'menu'].includes(id));
    expect(phone).toEqual(['create', 'join', 'menu']);
    // Стол: меню нет, есть сами кнопки.
    const desk = tourSteps((id) => id !== 'menu');
    expect(desk).toEqual(['create', 'join', 'favorites', 'settings', 'help']);
  });

  it('has nothing to show when the main buttons are not there', () => {
    expect(tourSteps((id) => id === 'help')).toEqual([]);
  });
});
