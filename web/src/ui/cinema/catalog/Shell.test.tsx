import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Shell } from './Shell';

/*
  Поле поиска кинозала отличает вставку целиком от набора по букве: вставленную ссылку спрашивают
  у службы сразу, набранную — только по Enter. Каждая пауза в наборе была бы разбором чужой страницы.
*/

afterEach(cleanup);

function Field({
  onSearch,
  onSubmit,
  maxLength,
}: {
  onSearch: (query: string, whole: boolean) => void;
  onSubmit: (query: string) => void;
  maxLength?: number;
}) {
  const [query, setQuery] = useState('');
  return (
    <Shell
      query={query}
      placeholder="Поиск"
      maxLength={maxLength}
      onSearch={(value, whole) => {
        setQuery(value);
        onSearch(value, whole);
      }}
      onSubmit={onSubmit}
      onClear={() => setQuery('')}
      watching={false}
      onClose={() => {}}
      locked={false}
      error=""
    >
      {null}
    </Shell>
  );
}

it('вставку целиком отличает от набора по букве, а Enter отдаёт набранное', () => {
  const onSearch = vi.fn();
  const onSubmit = vi.fn();
  render(<Field onSearch={onSearch} onSubmit={onSubmit} />);
  const input = screen.getByPlaceholderText('Поиск');
  const typed = (value: string, init: Record<string, unknown>) =>
    fireEvent.input(input, { target: { value }, ...init });

  // По букве — не вставка.
  typed('h', { inputType: 'insertText', data: 'h' });
  expect(onSearch).toHaveBeenLastCalledWith('h', false);
  // Из буфера: событие `paste`, и следом изменение поля — как бы браузер его ни назвал.
  fireEvent.paste(input);
  typed('https://ok.ru/video/1', { inputType: 'insertText', data: 'ttps://ok.ru/video/1' });
  expect(onSearch).toHaveBeenLastCalledWith('https://ok.ru/video/1', true);
  // Браузер сам назвал изменение вставкой.
  typed('https://ok.ru/video/2', { inputType: 'insertFromPaste', data: null });
  expect(onSearch).toHaveBeenLastCalledWith('https://ok.ru/video/2', true);
  // Много знаков одним набором (подсказка клавиатуры с буфером) — вставка, и поверх более длинного.
  typed('https://a.ru/x', { inputType: 'insertText', data: 'https://a.ru/x' });
  expect(onSearch).toHaveBeenLastCalledWith('https://a.ru/x', true);
  // Слово, которое клавиатура телефона ещё составляет по букве, — набор.
  typed('https://examp', { inputType: 'insertCompositionText', data: 'examp', isComposing: true });
  expect(onSearch).toHaveBeenLastCalledWith('https://examp', false);
  // Вставка, которая ничего не изменила, не делает вставкой следующую букву.
  fireEvent.paste(input);
  fireEvent.keyDown(input, { key: 'l' });
  typed('https://exampl', { inputType: 'insertText', data: 'l' });
  expect(onSearch).toHaveBeenLastCalledWith('https://exampl', false);

  // Enter посреди составления слова — ещё не Enter; обычный — набранное целиком.
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSubmit).toHaveBeenCalledWith('https://exampl');
});

/*
  Предел поиска: служба не принимает запрос длиннее 120 знаков и отвечала на такой 422, а интерфейс
  показывал «[object Object]». Поле длиннее не набирается — но ссылка в поиске не слова, и обрезать
  её браузеру нельзя: обрезанная, она вела бы на другую страницу.
*/
it('поле поиска с пределом не набирается длиннее, а поле без предела — ограничено только ссылкой', () => {
  render(<Field onSearch={vi.fn()} onSubmit={vi.fn()} maxLength={120} />);
  expect(screen.getByPlaceholderText('Поиск')).toHaveAttribute('maxLength', '120');
  cleanup();
  render(<Field onSearch={vi.fn()} onSubmit={vi.fn()} />);
  expect(screen.getByPlaceholderText('Поиск')).not.toHaveAttribute('maxLength');
});

it('ссылку длиннее предела вставка отдаёт целиком, а длинные слова — нет', () => {
  const onSearch = vi.fn();
  render(<Field onSearch={onSearch} onSubmit={vi.fn()} maxLength={120} />);
  const input = screen.getByPlaceholderText('Поиск') as HTMLInputElement;
  const link = `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${'P'.repeat(60)}&index=12&pp=${'x'.repeat(30)}`;
  expect(link.length).toBeGreaterThan(120);

  const pasted = fireEvent.paste(input, { clipboardData: { getData: () => link } });
  // Вставку сделало само поле: браузер её не делает (иначе обрезал бы), а сцена получает всю ссылку.
  expect(pasted).toBe(false);
  expect(onSearch).toHaveBeenLastCalledWith(link, true);
  expect(input.value).toBe(link);

  // Слова длиннее предела поле не перехватывает — их обрежет сам браузер.
  onSearch.mockClear();
  fireEvent.change(input, { target: { value: '' } });
  onSearch.mockClear();
  expect(fireEvent.paste(input, { clipboardData: { getData: () => 'слово '.repeat(30) } })).toBe(true);
  expect(onSearch).not.toHaveBeenCalled();
  // И короткую ссылку тоже: она влезает, и её вставляет браузер, как раньше.
  expect(fireEvent.paste(input, { clipboardData: { getData: () => 'https://youtu.be/dQw4w9WgXcQ' } })).toBe(
    true,
  );
});
