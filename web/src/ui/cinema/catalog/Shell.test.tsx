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
}: {
  onSearch: (query: string, whole: boolean) => void;
  onSubmit: (query: string) => void;
}) {
  const [query, setQuery] = useState('');
  return (
    <Shell
      query={query}
      placeholder="Поиск"
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
