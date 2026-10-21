import { describe, expect, it } from 'vitest';
import stage from './stage.css?raw';
import dock from './call-dock.css?raw';
import panel from './meeting-panel.css?raw';
import cinema from './cinema/cinema.css?raw';
import { COMPACT, DRAWER, DRAWER_WIDTH, ROOMY, SHEET } from './breakpoints';

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
  it('телефон: пульт в одну строку и без правой группы — там же, где код уносит её в «ещё»', () => {
    expect(rule(media(dock, COMPACT), '.call-footer')).toContain('grid-template-columns: minmax(0, 1fr);');
    expect(rule(media(dock, COMPACT), '.meeting-page')).toContain('--dock-bottom:');
  });

  it('лист: панель встречи ложится во весь низ ровно на границе `SHEET`', () => {
    const sheet = rule(media(panel, SHEET), '.side-panel');
    expect(sheet).toContain('left: var(--space-2);');
    expect(sheet).toContain('width: auto;');
  });

  it('полоса: панель поверх сцены на границе `DRAWER` и шириной `DRAWER_WIDTH`', () => {
    const drawer = rule(media(panel, DRAWER), '.side-panel');
    expect(drawer).toContain('position: absolute;');
    expect(drawer).toContain(`width: ${DRAWER_WIDTH}px;`);
  });

  it('кинозал отодвигается от полосы с `ROOMY` до `DRAWER`, ровно на её ширину', () => {
    const beside = rule(
      media(cinema, `${ROOMY} and ${DRAWER}`),
      '.meeting-page:not(.meeting-fullscreen) .meeting-body.panel-open .watch-together-stage',
    );
    expect(beside).toContain(`padding-right: calc(${DRAWER_WIDTH}px + 12px - 16px);`);
  });

  /*
    Аудит чёткости E15-B: на 1024 полоса панели накрывала «…» и имена плиток. Разговор и показ экрана
    отодвигаются от полосы с первой ширины после листа (`SHEET` + 1), столы — с `ROOMY`, как кинозал.
  */
  it('плитки и столы отодвигаются от полосы панели на её ширину, а не лежат под ней', () => {
    const afterSheet = `(min-width: ${Number(/\d+/.exec(SHEET)![0]) + 1}px)`;
    const beside = `padding-right: calc(${DRAWER_WIDTH}px + 12px - 16px);`;
    const talk = media(stage, `${afterSheet} and ${DRAWER}`);
    expect(talk).toContain('.stage:is(.conversation-stage, .watch-stage) {');
    expect(talk).toContain(beside);
    const tables = media(stage, `${ROOMY} and ${DRAWER}`);
    expect(tables).toContain('.stage:is(.poker-stage, .room-game-stage) {');
    expect(tables).toContain(beside);
  });

  it('в полосе лиц над листом панели у плиток нет «…»: действия — в строке человека рядом', () => {
    expect(media(stage, SHEET)).toMatch(
      /\.meeting-body\.panel-open \.stage \.people-grid \.person-tile > \.participant-more \{\s*display: none;/,
    );
  });

  it('панель поверх сцены кончается над пультом звонка — там же, где кончается сцена', () => {
    expect(rule(media(panel, DRAWER), '.side-panel')).toContain('bottom: var(--dock-space);');
    expect(rule(stage, '.stage-wrap')).toContain('padding: var(--space-3) var(--space-3) var(--dock-space);');
    expect(rule(stage, '.meeting-page')).toContain(
      '--dock-space: calc(var(--dock-height) + 2 * var(--dock-bottom));',
    );
  });

  it('экран звонка пишется без `!important`: переопределения по весу уже ломали столы', () => {
    for (const css of [stage, dock, panel]) expect(css).not.toContain('!important');
  });
});
