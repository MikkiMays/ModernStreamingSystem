import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Tabs } from './Tabs';

/*
  Ряд вкладок — одна остановка Tab на весь ряд, а по ряду ходят стрелками.

  У разделов Rutube вкладок сорок три, и каждая раньше была своей остановкой: чтобы добраться с
  поля поиска до первой полки, клавиатура нажимала Tab сорок с лишним раз. Выбор — Enter или
  пробел (ручная активация): каждый раздел — это запрос к площадке, и пробегать по ним стрелками,
  спрашивая каждый, незачем.
*/

const ITEMS = [
  { id: '', name: 'Главная' },
  { id: '4', name: 'Фильмы' },
  { id: '5', name: 'Сериалы' },
  { id: '7', name: 'Мультфильмы' },
];

afterEach(cleanup);

function mount(selected = '4') {
  const onSelect = vi.fn();
  render(
    <Tabs
      label="Разделы"
      items={ITEMS}
      selected={selected}
      onSelect={onSelect}
      className="cinema-chips"
      tabClassName="cinema-chip-button"
    />,
  );
  const tab = (name: string) => screen.getByRole('tab', { name });
  return { onSelect, tab };
}

/** Нажать клавишу там, где сейчас фокус, — как это делает клавиатура. */
function press(key: string) {
  const target = document.activeElement as HTMLElement;
  return fireEvent.keyDown(target, { key });
}

describe('Tabs: ряд вкладок с одной остановкой Tab', () => {
  it('остановка Tab — только на выбранной вкладке', () => {
    const { tab } = mount('4');
    expect(screen.getByRole('tablist', { name: 'Разделы' })).toHaveClass('cinema-chips');
    expect(ITEMS.map((item) => tab(item.name).tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(tab('Фильмы')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Главная')).toHaveAttribute('aria-selected', 'false');
    expect(tab('Главная')).toHaveClass('cinema-chip-button');
  });

  it('если выбранной в ряду нет, остановка — на первой: ряд не выпадает из клавиатуры', () => {
    const { tab } = mount('99');
    expect(ITEMS.map((item) => tab(item.name).tabIndex)).toEqual([0, -1, -1, -1]);
  });

  it('стрелки ведут фокус по ряду и с краю переходят на другой край', () => {
    const { tab } = mount('4');
    tab('Фильмы').focus();
    press('ArrowRight');
    expect(document.activeElement).toBe(tab('Сериалы'));
    press('ArrowRight');
    press('ArrowRight');
    expect(document.activeElement).toBe(tab('Главная'));
    press('ArrowLeft');
    expect(document.activeElement).toBe(tab('Мультфильмы'));
  });

  it('Home и End — к первой и последней', () => {
    const { tab } = mount('4');
    tab('Фильмы').focus();
    press('End');
    expect(document.activeElement).toBe(tab('Мультфильмы'));
    press('Home');
    expect(document.activeElement).toBe(tab('Главная'));
  });

  it('стрелки не выбирают: выбирает нажатие (Enter, пробел, мышь)', () => {
    const { onSelect, tab } = mount('4');
    tab('Фильмы').focus();
    press('ArrowRight');
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(document.activeElement as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith('5');
    fireEvent.click(tab('Главная'));
    expect(onSelect).toHaveBeenLastCalledWith('');
  });

  it('свои клавиши ряд забирает у страницы, чужие — нет', () => {
    const { tab } = mount('4');
    tab('Фильмы').focus();
    // `fireEvent` отвечает `false`, если обработчик отменил действие по умолчанию.
    expect(press('ArrowRight')).toBe(false);
    expect(press('Tab')).toBe(true);
    expect(press('a')).toBe(true);
  });
});
