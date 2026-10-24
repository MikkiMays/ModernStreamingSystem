import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('../../api/client', () => ({
  prepareHuman: vi.fn(),
  publicApi: { support: (...args: unknown[]) => send(...args) },
}));

import { SupportForm } from './SupportForm';
import { HelpCenter } from './HelpCenter';
import { ReportForm } from './ReportForm';
import { callReportSource, provideCallReport } from './help';

afterEach(() => {
  cleanup();
  send.mockReset();
  act(() => callReportSource.set(null));
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

  it('тема — чипами (R38); без переключателя диагностика не уходит; после отправки — номер и честный ответ', async () => {
    send.mockResolvedValue({ id: '1a2b3c4d-0000-4000-8000-000000000000', number: '1A2B3C4D' });
    render(<SupportForm topic="camera" />);
    const topics = screen.getByRole('radiogroup', { name: 'Тема' });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(within(topics).getByRole('radio', { name: 'Камера и микрофон' })).toBeChecked();
    fireEvent.click(within(topics).getByRole('radio', { name: 'Звук' }));
    expect(within(topics).getByRole('radio', { name: 'Звук' })).toBeChecked();
    fireEvent.change(message(), { target: { value: 'Во встрече не слышно собеседника' } });
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByText('Обращение 1A2B3C4D отправлено');
    expect(send).toHaveBeenCalledWith({
      topic: 'sound',
      message: 'Во встрече не слышно собеседника',
      contact: null,
      diagnostics: null,
      consent: false,
    });
    expect(screen.getByText(/Контакт вы не оставили/)).toBeInTheDocument();
  });

  it('с переключателем показывает, что уйдёт, и отправляет ровно это (X4)', async () => {
    send.mockResolvedValue({ id: 'x', number: 'ABCDEF12' });
    render(<SupportForm />);
    fireEvent.change(message(), { target: { value: 'Не слышно собеседника совсем' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Как с вами связаться' }), {
      target: { value: '@someone' },
    });
    // Да или нет — переключатель, а не галочка (X4).
    expect(screen.queryByRole('checkbox', { name: /Приложить диагностику/ })).toBeNull();
    const consent = screen.getByRole('switch', { name: /Приложить диагностику/ });
    expect(consent).not.toBeChecked();
    fireEvent.click(consent);
    expect(consent).toBeChecked();
    // «Что будет отправлено» — кнопкой, а не `<details>` с системным ▼.
    expect(document.querySelector('details, summary')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Что будет отправлено' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const shown = document.getElementById(toggle.getAttribute('aria-controls')!)!.textContent!;
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

describe('«Сообщить о проблеме» (R79)', () => {
  const call = {
    seconds: 312,
    rttMs: 57,
    lossPercent: 0.2,
    jitterMs: 4,
    bitrateKbps: 160,
    freezes: 1,
    freezeSeconds: 2,
    lossySeconds: 0,
    path: 'direct-udp' as const,
    codec: 'vp9' as const,
  };

  it('отмеченное — чипами, отчёт о звонке приложен сам и виден до отправки', async () => {
    send.mockResolvedValue({ id: 'r', number: 'REPORT01' });
    act(() => {
      provideCallReport(() => call);
    });
    render(<ReportForm />);
    const what = screen.getByRole('group', { name: 'Что не так' });
    // Ничего не отмечено — не уходит, и сказано почему.
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Отметьте, что не так');
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(within(what).getByRole('checkbox', { name: 'Не слышно музыку' }));
    fireEvent.click(within(what).getByRole('checkbox', { name: 'Звук обрывается' }));
    expect(within(what).getByRole('checkbox', { name: 'Звук обрывается' })).toBeChecked();
    expect(screen.queryByRole('alert')).toBeNull();
    const consent = screen.getByRole('switch', { name: /Приложить отчёт о звонке/ });
    expect(consent).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Что будет отправлено' }));
    const preview = screen.getByText(/call: 312 s/);
    expect(preview.textContent).toMatch(/^cord: /);
    expect(preview.textContent).toContain('freezes: 1 (2 s)');
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByText('Обращение REPORT01 отправлено');
    const body = send.mock.calls[0]![0];
    // Порядок — по списку, а не по нажатиям; подробности не обязательны.
    expect(body).toMatchObject({ topic: 'report', issues: ['sound', 'music'], message: '', consent: true });
    expect(body.diagnostics).toBe(preview.textContent);
  });

  it('выключенный отчёт не уходит; вне встречи прикладывать нечего, кроме диагностики', async () => {
    send.mockResolvedValue({ id: 'r', number: 'REPORT02' });
    render(<ReportForm />);
    expect(screen.queryByRole('switch', { name: /отчёт о звонке/ })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: /Приложить диагностику/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Не подключается' }));
    fireEvent.click(screen.getByRole('button', { name: 'Отправить' }));
    await screen.findByText('Обращение REPORT02 отправлено');
    expect(send.mock.calls[0]![0]).toMatchObject({ issues: ['connect'], diagnostics: null, consent: false });
  });
});

describe('поддержка вкладками (R38)', () => {
  it('три вкладки; вопрос, у которого застряли, раскрыт; форма начинается с его темы', () => {
    render(<HelpCenter faq="smartscreen" />);
    const tabs = screen.getByRole('tablist', { name: 'Разделы поддержки' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Частые вопросы', 'Проверить', 'Написать']);
    expect(within(tabs).getByRole('tab', { name: 'Частые вопросы' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Вопросы — аккордеон на кнопках, без `<details>`; открытый — первым.
    expect(document.querySelector('details, summary')).toBeNull();
    const [first] = screen.getAllByRole('button', { expanded: true });
    expect(first).toHaveTextContent('Windows пишет');
    fireEvent.click(within(tabs).getByRole('tab', { name: 'Написать' }));
    expect(screen.getByRole('radio', { name: 'Приложение для Windows' })).toBeChecked();
    // Ни строки автора, ни одной ссылки наружу (R51, Р-29).
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body.textContent).not.toMatch(/nikgers|автор/i);
  });

  it('открыт один вопрос: раскрыли другой — прежний закрылся', () => {
    render(<HelpCenter />);
    const [camera, , silent] = screen.getAllByRole('button', { expanded: false });
    fireEvent.click(camera!);
    expect(camera).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(silent!);
    expect(silent).toHaveAttribute('aria-expanded', 'true');
    expect(camera).toHaveAttribute('aria-expanded', 'false');
  });

  it('«Сообщить о проблеме» открывается сразу на «Написать», а недописанное переживает смену вкладки', () => {
    render(<HelpCenter report />);
    expect(screen.getByRole('tab', { name: 'Написать' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('radio', { name: 'Сообщить о проблеме' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Написать нам' }));
    fireEvent.change(message(), { target: { value: 'Пишу и отвлекаюсь' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Частые вопросы' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Написать' }));
    expect(message()).toHaveValue('Пишу и отвлекаюсь');
  });

  it('во встрече вместо проверки устройств ведёт в её диагностику', () => {
    const onDiagnostics = vi.fn();
    render(<HelpCenter onDiagnostics={onDiagnostics} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Проверить' }));
    fireEvent.click(screen.getByRole('button', { name: 'Открыть диагностику' }));
    expect(onDiagnostics).toHaveBeenCalled();
  });
});
