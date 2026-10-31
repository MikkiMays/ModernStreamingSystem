import { expect, it } from 'vitest';
import poker from '../poker.css?raw';
import durak from '../durak.css?raw';
import people from '../game-people.css?raw';

/*
  R155: камера с телефона за столом игры была вертикальным овалом. Кадр стоял в сетке лица с
  `height: 100%`, и портретная дорожка своей высотой растягивала лицо. Кадр должен лежать поверх
  лица вне потока — тогда размер задаёт только лицо.
*/
/** Все объявления правил, где селектор стоит последним перед `{` (и в составных правилах тоже). */
const rule = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = css.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'));
  return [...matches].map((match) => match[1]).join('\n');
};

it.each([
  ['покер', poker, '.poker-camera'],
  ['дурак', durak, '& .durak-seat-face video'],
  ['люди за столом', people, '.game-person-face video'],
])('%s: кадр камеры поверх лица, вне сетки', (_, css, selector) => {
  const body = rule(css, selector);
  expect(body).toMatch(/position:\s*absolute/);
  expect(body).toMatch(/inset:\s*0/);
});
