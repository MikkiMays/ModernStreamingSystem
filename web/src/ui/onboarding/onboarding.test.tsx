import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { markSeen, onboarding, readOnboarding, replayOnboarding } from '../../core/onboarding';
import { HomeTour, OnceHint } from './Onboarding';

/*
  jsdom не раскладывает страницу: у всех элементов нулевой размер, и знакомство сочло бы, что кнопок
  на экране нет. Кнопкам с `data-tour` даём место, остальным — нет: так проверяется и пропуск шага.
*/
const original = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const sized = this.hasAttribute('data-tour') && !this.hasAttribute('data-hidden');
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 40,
      right: 120,
      width: sized ? 120 : 0,
      height: sized ? 40 : 0,
      toJSON() {},
    };
  };
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = original;
});
beforeEach(() => {
  localStorage.clear();
  onboarding.set(readOnboarding());
});
afterEach(cleanup);

function Home() {
  return (
    <>
      <button data-tour="create">Новая встреча</button>
      <div data-tour="join">
        <input aria-label="Код" />
      </div>
      {/* Закрытое меню на телефоне: кнопка в документе, но места не занимает. */}
      <button data-tour="favorites" data-hidden="">
        Избранное
      </button>
      <button data-tour="settings">Настройки</button>
      <HomeTour />
    </>
  );
}

const step = (title: string) => screen.findByRole('dialog', { name: title }, { timeout: 3000 });

describe('знакомство на главной', () => {
  it('свежий профиль проходит его до конца, и второй раз оно не показывается', async () => {
    const { unmount } = render(<Home />);
    expect(await step('Новая встреча')).toHaveTextContent('1 из 3');
    expect(screen.getByText('Новая встреча', { selector: 'button' })).toHaveAttribute(
      'data-coachmark-target',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    expect(await step('Вас пригласили?')).toHaveTextContent('2 из 3');
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    // Избранного на экране нет — шаг пропущен, следом настройки.
    expect(await step('Настройки')).toHaveTextContent('3 из 3');
    expect(screen.queryByRole('button', { name: 'Пропустить' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Готово' }));
    expect(onboarding.get().tour).toBe(true);
    expect(readOnboarding().tour).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Новая встреча', { selector: 'button' })).not.toHaveAttribute(
      'data-coachmark-target',
    );

    // Повторный запуск — то же устройство: знакомства нет.
    unmount();
    render(<Home />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 800)));
    expect(screen.queryByRole('dialog')).toBeNull();

    // «Пройти знакомство» — снова с первого шага.
    act(() => replayOnboarding());
    expect(await step('Новая встреча')).toHaveTextContent('1 из 3');
  });

  it('«Пропустить» закрывает его насовсем', async () => {
    render(<Home />);
    await step('Новая встреча');
    fireEvent.click(screen.getByRole('button', { name: 'Пропустить' }));
    expect(onboarding.get().tour).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ждёт, пока закрыто окно поверх главной', async () => {
    const { rerender } = render(<HomeTour paused />);
    rerender(
      <>
        <button data-tour="create">Новая встреча</button>
        <HomeTour paused />
      </>,
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 800)));
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(
      <>
        <button data-tour="create">Новая встреча</button>
        <HomeTour />
      </>,
    );
    expect(await step('Новая встреча')).toBeInTheDocument();
  });
});

describe('подсказка один раз', () => {
  it('у пульта при первом входе во встречу, и больше никогда', async () => {
    const anchor = document.createElement('div');
    anchor.setAttribute('data-tour', 'dock');
    document.body.append(anchor);
    const { rerender } = render(<OnceHint id="meeting" anchor={anchor} ready={false} />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 800)));
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<OnceHint id="meeting" anchor={anchor} ready />);
    expect(await step('Вы во встрече')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Понятно' }));
    expect(readOnboarding().meeting).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    anchor.remove();
  });

  it('уже виденная не показывается', async () => {
    act(() => markSeen('integrations'));
    const anchor = document.createElement('h2');
    document.body.append(anchor);
    render(<OnceHint id="integrations" anchor={anchor} />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 800)));
    expect(screen.queryByRole('dialog')).toBeNull();
    anchor.remove();
  });
});
