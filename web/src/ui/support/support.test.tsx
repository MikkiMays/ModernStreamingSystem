import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('../../api/client', () => ({
  prepareHuman: vi.fn(),
  publicApi: { support: (...args: unknown[]) => send(...args) },
}));

import { SupportForm } from './SupportForm';
import { HelpCenter } from './HelpCenter';

afterEach(() => {
  cleanup();
  send.mockReset();
});

const message = () => screen.getByRole('textbox', { name: 'Что случилось' });

describe('форма обращения', () => {
  it('не уходит пустой и говорит почему', () => {
    render(<SupportForm />);
    fireEvent.change(message(), { target: { value: 'ой' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(screen.getByText('Опишите, что случилось, — хотя бы одним предложением')).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it('без галочки диагностика не уходит; после отправки — номер и честный ответ про контакт', async () => {
    send.mockResolvedValue({ id: '1a2b3c4d-0000-4000-8000-000000000000', number: '1A2B3C4D' });
    render(<SupportForm topic="camera" />);
    expect(screen.getByRole('combobox', { name: 'Тема' })).toHaveValue('camera');
    fireEvent.change(message(), { target: { value: 'Во встрече не включается камера' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByText('Обращение 1A2B3C4D отправлено');
    expect(send).toHaveBeenCalledWith({
      topic: 'camera',
      message: 'Во встрече не включается камера',
      contact: null,
      diagnostics: null,
      consent: false,
    });
    expect(screen.getByText(/Контакт вы не оставили/)).toBeInTheDocument();
  });

  it('с галочкой показывает, что уйдёт, и отправляет ровно это', async () => {
    send.mockResolvedValue({ id: 'x', number: 'ABCDEF12' });
    render(<SupportForm />);
    fireEvent.change(message(), { target: { value: 'Не слышно собеседника совсем' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Как с вами связаться' }), {
      target: { value: '@someone' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Приложить диагностику/ }));
    const preview = screen.getByText('Что будет отправлено').closest('details')!;
    const shown = preview.querySelector('pre')!.textContent!;
    expect(shown).toMatch(/^cord: /);
    expect(shown).toContain('client: web');
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0]![0]).toMatchObject({ contact: '@someone', diagnostics: shown, consent: true });
    expect(await screen.findByText('Ответим по контакту, который вы оставили.')).toBeInTheDocument();
  });

  it('показывает отказ сервера словами', async () => {
    send.mockRejectedValue(new Error('С этого адреса уже пришло несколько обращений'));
    render(<SupportForm />);
    fireEvent.change(message(), { target: { value: 'Пятое обращение за час' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByText('С этого адреса уже пришло несколько обращений')).toBeInTheDocument();
  });
});

describe('помощь', () => {
  it('раскрывает вопрос, у которого человек застрял, и начинает форму с его темы', () => {
    render(<HelpCenter faq="smartscreen" />);
    const questions = screen.getAllByRole('group');
    expect(questions[0]).toHaveTextContent('Windows пишет');
    expect(questions[0]).toHaveAttribute('open');
    expect(screen.getByRole('combobox', { name: 'Тема' })).toHaveValue('windows');
    // Тот же Telegram автора, что в «О программе», и ни одной ссылки на исходники.
    const links = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(links).toContain('https://t.me/nikgers');
    expect(links.join(' ')).not.toMatch(/github/i);
  });

  it('во встрече вместо проверки устройств ведёт в её диагностику', () => {
    const onDiagnostics = vi.fn();
    render(<HelpCenter onDiagnostics={onDiagnostics} />);
    fireEvent.click(screen.getByRole('button', { name: 'Открыть диагностику' }));
    expect(onDiagnostics).toHaveBeenCalled();
  });
});
