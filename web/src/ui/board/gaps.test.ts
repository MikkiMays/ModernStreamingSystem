import { afterEach, expect, it } from 'vitest';
import { fillGaps, guardGaps } from './gaps';

const gaps = new Map([
  ['Type or paste your link here', 'Введите или вставьте ссылку'],
  ['Frame tool', 'Рамка'],
]);

afterEach(() => {
  document.body.innerHTML = '';
});

it('подменяет английские строки Excalidraw в тексте и подписях, но не вне редактора и не в содержимом', () => {
  document.body.innerHTML = `
    <div class="excalidraw">
      <input placeholder="Type or paste your link here" />
      <button title="Frame tool — F"><span>Frame tool</span></button>
      <a class="excalidraw-hyperlinkContainer-link">Frame tool</a>
    </div>
    <p>Frame tool</p>`;
  fillGaps(document.body, gaps);
  expect(document.querySelector('input')!.placeholder).toBe('Введите или вставьте ссылку');
  expect(document.querySelector('button')!.title).toBe('Рамка — F');
  expect(document.querySelector('button span')!.textContent).toBe('Рамка');
  expect(document.querySelector('a')!.textContent).toBe('Frame tool');
  expect(document.querySelector('p')!.textContent).toBe('Frame tool');
});

it('сторож подменяет то, что появилось позже, и отключается', async () => {
  document.body.innerHTML = '<div class="excalidraw"></div>';
  const stop = guardGaps(document, gaps);
  const root = document.querySelector('.excalidraw')!;
  root.innerHTML = '<input placeholder="Type or paste your link here" />';
  await Promise.resolve();
  expect(root.querySelector('input')!.placeholder).toBe('Введите или вставьте ссылку');
  stop();
  root.innerHTML = '<span>Frame tool</span>';
  await Promise.resolve();
  expect(root.textContent).toBe('Frame tool');
});

it('английский язык — сторож ничего не делает', () => {
  document.body.innerHTML = '<div class="excalidraw"><span>Frame tool</span></div>';
  guardGaps(document, new Map())();
  expect(document.body.textContent).toBe('Frame tool');
});
