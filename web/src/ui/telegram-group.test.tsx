import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../core/meeting';

const api = vi.hoisted(() => ({
  chats: vi.fn(),
  link: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock('../core/services', async (original) => ({
  ...(await original<typeof import('../core/services')>()),
  MusicApi: class {
    telegramChats = api.chats;
    linkTelegram = api.link;
    unlinkTelegram = api.unlink;
  },
}));
const { TelegramGroup } = await import('./TelegramGroup');

afterEach(cleanup);

const meeting = {
  admission: { roomId: 'room', participantId: 'host', credential: 'c' },
} as unknown as Meeting;
const chat = { id: 'bChat', chatTitle: 'Команда', since: 1, pinned: true };

function show() {
  const onBack = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TelegramGroup meeting={meeting} onBack={onBack} />
    </QueryClientProvider>,
  );
  return onBack;
}

describe('Telegram во встрече (E09)', () => {
  it('код привязки: «Добавить бота в группу» и команда для чата', async () => {
    api.chats.mockResolvedValue({ links: [] });
    api.link.mockResolvedValue({
      command: '/bind@cord_meet_bot TOKEN',
      expiresAt: 0,
      startgroupUrl: 'https://t.me/cord_meet_bot?startgroup=TOKEN&admin=pin_messages+manage_chat',
    });
    show();
    fireEvent.click(screen.getByRole('button', { name: /Привязать к беседе/ }));
    const add = await screen.findByRole('link', { name: /Добавить бота в группу/ });
    expect(add).toHaveAttribute(
      'href',
      'https://t.me/cord_meet_bot?startgroup=TOKEN&admin=pin_messages+manage_chat',
    );
    expect(add).toHaveAttribute('rel', 'noreferrer');
    expect(screen.getByText('/bind@cord_meet_bot TOKEN')).toBeInTheDocument();
    expect(screen.getByText('Код действует 15 минут и срабатывает один раз')).toBeInTheDocument();
  });

  it('привязанные беседы видны и отвязываются', async () => {
    api.chats.mockResolvedValue({ links: [chat] });
    api.unlink.mockResolvedValue({ links: [] });
    const onBack = show();
    expect(await screen.findByText('Команда')).toBeInTheDocument();
    expect(screen.getByText('Кнопка закреплена в чате')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Отвязать беседу «Команда»' }));
    expect(api.unlink).toHaveBeenCalledWith('bChat');
    await screen.findByRole('button', { name: /Привязать к беседе/ });
    expect(screen.queryByText('Команда')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /К интеграциям/ }));
    expect(onBack).toHaveBeenCalled();
  });
});
