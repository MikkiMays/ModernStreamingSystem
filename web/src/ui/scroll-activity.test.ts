import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import styles from '../styles.css?raw';
import { installScrollActivity } from './scroll-activity';

/*
  Тихие полосы прокрутки (R17, S2): бегунок длинной колонки виден под курсором и ещё 800 мс после
  прокрутки — чтобы и с клавиатуры (PageDown, стрелки) было видно, где ты.
*/

let uninstall = () => {};
let list: HTMLElement;
// `scroll` у элемента не всплывает: ловить его можно только перехватом на документе.
const scroll = (target: EventTarget = list) => target.dispatchEvent(new Event('scroll'));

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div class="settings-content"><p>…</p></div>';
  list = document.querySelector<HTMLElement>('.settings-content')!;
  uninstall = installScrollActivity(document);
});
afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

it('прокрутка помечает область на 800 мс', () => {
  scroll();
  expect(list).toHaveAttribute('data-scrolling');
  vi.advanceTimersByTime(799);
  expect(list).toHaveAttribute('data-scrolling');
  vi.advanceTimersByTime(1);
  expect(list).not.toHaveAttribute('data-scrolling');
});

it('продолжение прокрутки продлевает пометку', () => {
  scroll();
  vi.advanceTimersByTime(600);
  scroll();
  vi.advanceTimersByTime(600);
  expect(list).toHaveAttribute('data-scrolling');
  vi.advanceTimersByTime(200);
  expect(list).not.toHaveAttribute('data-scrolling');
});

it('прокрутка страницы помечает корень документа', () => {
  scroll(document);
  expect(document.documentElement).toHaveAttribute('data-scrolling');
});

it('снятие отключает слушателя', () => {
  uninstall();
  scroll();
  expect(list).not.toHaveAttribute('data-scrolling');
});

it('CSS прячет бегунок длинных колонок, пока курсор не над ними и они не едут', () => {
  expect(styles).toMatch(
    /:is\(\.settings-nav, \.settings-content, \.home-nav__scroll, \.panel-body\):not\(:hover, \[data-scrolling\]\) \{\s*--scrollbar-thumb: transparent;/,
  );
});
