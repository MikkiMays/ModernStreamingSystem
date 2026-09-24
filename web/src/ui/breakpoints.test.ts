import { describe, expect, it } from 'vitest';
import styles from '../styles.css?raw';
import layout from '../room-layout.css?raw';
import { COMPACT, DOCK, DRAWER, DRAWER_WIDTH, ROOMY, SHEET } from './breakpoints';

/*
  Границы раскладки записаны дважды — в CSS и в `breakpoints.ts`, откуда их берёт код, — и
  расходиться не должны. Здесь CSS читается как текст, и каждая граница ищется там, где она
  действительно решает раскладку: строка `@media` вместе с правилом, ради которого она стоит.
  Поменяли число с одной стороны — тест падает, пока не поменяют и с другой.
*/

/** Тела всех блоков `@media <query> { … }` файла, склеенные в одну строку. */
function media(css: string, query: string): string {
  const head = `@media ${query} {`;
  const bodies: string[] = [];
  for (let at = css.indexOf(head); at >= 0; at = css.indexOf(head, at + head.length)) {
    let depth = 1;
    let end = at + head.length;
    while (depth > 0 && end < css.length) {
      if (css[end] === '{') depth += 1;
      if (css[end] === '}') depth -= 1;
      end += 1;
    }
    bodies.push(css.slice(at + head.length, end - 1));
  }
  return bodies.join('\n');
}

/** Объявления правила с этим селектором внутри текста: `селектор { … }`. */
function rule(css: string, selector: string): string {
  const head = `${selector} {`;
  const at = css.split('\n').findIndex((line) => line.trim() === head);
  if (at < 0) return '';
  const rest = css.split('\n').slice(at + 1);
  return rest
    .slice(
      0,
      rest.findIndex((line) => line.trim() === '}'),
    )
    .join('\n');
}

describe('границы раскладки: CSS и код считают по одним числам', () => {
  it('телефон: пульт звонка на всю ширину — там же, где код уносит кнопки в меню', () => {
    expect(rule(media(layout, COMPACT), '.meeting-page')).toContain('--dock:');
  });

  it('лист: панель встречи ложится во весь низ ровно на границе `SHEET`', () => {
    const sheet = rule(media(styles, SHEET), '.side-panel');
    expect(sheet).toContain('left: 8px;');
    expect(sheet).toContain('width: auto;');
  });

  it('настольный пульт сжимается, чтобы поместиться в сцену, сразу за границей листа', () => {
    // Граница пульта — следующий пиксель после листа: между ними не должно быть ширины ни того,
    // ни другого.
    expect(Number(/\d+/.exec(DOCK)![0])).toBe(Number(/\d+/.exec(SHEET)![0]) + 1);
    expect(rule(media(layout, DOCK), '.stage-wrap > .call-footer .call-dock .icon-button')).toContain(
      'min-width: 44px;',
    );
  });

  it('полоса: панель поверх сцены на границе `DRAWER` и шириной `DRAWER_WIDTH`', () => {
    const drawer = rule(media(styles, DRAWER), '.side-panel');
    expect(drawer).toContain('position: absolute;');
    expect(drawer).toContain(`width: ${DRAWER_WIDTH}px;`);
  });

  it('кинозал отодвигается от полосы с `ROOMY` до `DRAWER`, ровно на её ширину', () => {
    const beside = rule(
      media(layout, `${ROOMY} and ${DRAWER}`),
      '.meeting-page:not(.meeting-fullscreen) .meeting-body.panel-open .watch-together-stage',
    );
    expect(beside).toContain(`padding-right: calc(${DRAWER_WIDTH}px + 12px - 16px);`);
  });

  it('панель поверх сцены кончается над пультом звонка — там же, где кончается сцена', () => {
    expect(rule(media(layout, DRAWER), '.meeting-page:not(.meeting-fullscreen) .side-panel')).toContain(
      'bottom: var(--dock-space);',
    );
    expect(rule(layout, '.stage-wrap')).toContain('padding-bottom: var(--dock-space);');
  });
});
