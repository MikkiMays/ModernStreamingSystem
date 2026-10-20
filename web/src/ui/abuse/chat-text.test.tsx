import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatText, splitLinks } from './ChatText';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('ссылки выделяются из текста вместе с настоящим доменом, знаки препинания остаются текстом', () => {
  expect(splitLinks('Смотри https://example.com/a?b=1, и всё.')).toEqual([
    { text: 'Смотри ' },
    { url: 'https://example.com/a?b=1', host: 'example.com' },
    { text: ', и всё.' },
  ]);
  expect(splitLinks('без ссылок')).toEqual([{ text: 'без ссылок' }]);
});

it('домен на кириллице показывает форму xn--, переход — только после «Открыть»', () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  render(<ChatText text="Вход: https://сбербанк.рф/login" />);
  const link = screen.getByRole('link');
  expect(link.textContent).toContain('(xn--');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  fireEvent.click(link);
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog').textContent).toContain('Ссылка ведёт на xn--');
  fireEvent.click(screen.getByRole('button', { name: 'Открыть' }));
  expect(open).toHaveBeenCalledWith('https://сбербанк.рф/login', '_blank', 'noopener,noreferrer');
});

it('латинский домен без лишней пометки', () => {
  render(<ChatText text="https://example.com" />);
  expect(screen.getByRole('link').textContent).toBe('https://example.com');
});
