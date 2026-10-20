import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import type { TelegramShell } from './sdk';

const ROOM = '11111111-2222-3333-4444-555555555555';
const INVITE = `https://cord.test/join/${ROOM}#invite=${'a'.repeat(43)}`;
const entry = { roomId: ROOM, title: 'Планёрка', name: 'Иван Петров', inviteUrl: INVITE };

const api = vi.hoisted(() => ({
  telegramEnter: vi.fn(),
  join: vi.fn(),
  openConnection: vi.fn(),
  probe: vi.fn(),
  meetings: [] as unknown[],
}));
vi.mock('../core/services', async (original) => ({
  ...(await original<typeof import('../core/services')>()),
  servicesApi: { telegramEnter: api.telegramEnter },
}));
vi.mock('../api/client', async (original) => ({
  ...(await original<typeof import('../api/client')>()),
  publicApi: { join: api.join },
}));
vi.mock('../core/session', async (original) => ({
  ...(await original<typeof import('../core/session')>()),
  openConnection: api.openConnection,
}));
vi.mock('./media-probe', () => ({ probeMicrophone: api.probe }));
vi.mock('../core/meeting', () => ({
  Meeting: class {
    constructor(
      readonly admission: unknown,
      readonly choices: unknown,
    ) {
      api.meetings.push(this);
    }
    dispose() {}
  },
}));
vi.mock('../ui/MeetingView', () => ({
  MeetingView: ({ onBackTarget }: { onBackTarget: (close: (() => void) | null) => void }) => (
    <button onClick={() => onBackTarget(() => {})}>встреча</button>
  ),
}));

const { TelegramApp } = await import('./TelegramApp');

function shell(): TelegramShell & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    initData: 'auth_date=1&hash=x',
    platform: 'ios',
    back: (handler) => calls.push(handler ? 'back:show' : 'back:hide'),
    haptic: (kind) => calls.push('haptic:' + kind),
    confirmClosing: (on) => calls.push('closing:' + on),
    openExternal: (url) => calls.push('open:' + url),
    close: () => calls.push('close'),
  };
}

describe('Mini App: вход во встречу беседы', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    api.meetings.length = 0;
    api.openConnection.mockResolvedValue({ ok: true, detail: '' });
    api.telegramEnter.mockResolvedValue(entry);
    api.probe.mockResolvedValue('ok');
    api.join.mockResolvedValue({
      roomId: ROOM,
      participantId: 'p',
      credential: 'c',
      inviteUrl: null,
      snapshot: {},
    });
  });

  it('сразу во встречу: имя из Telegram, без поля имени; микрофон включён, камера нет', async () => {
    const tg = shell();
    render(<TelegramApp shell={tg} />);
    await screen.findByText('встреча');
    expect(api.telegramEnter).toHaveBeenCalledWith('auth_date=1&hash=x');
    expect(api.join).toHaveBeenCalledWith(
      ROOM,
      expect.objectContaining({ invite: 'a'.repeat(43), name: 'Иван Петров' }),
      undefined,
    );
    expect(api.meetings[0]).toMatchObject({
      admission: { inviteUrl: INVITE },
      choices: { micOn: true, cameraOn: false },
    });
    expect(tg.calls).toEqual(expect.arrayContaining(['haptic:success', 'closing:true']));
    // Открыта панель — у Telegram появляется «Назад».
    fireEvent.click(screen.getByText('встреча'));
    expect(tg.calls).toContain('back:show');
  });

  it('нет микрофона — экран с браузером и входом без микрофона', async () => {
    api.probe.mockResolvedValue('denied');
    const tg = shell();
    render(<TelegramApp shell={tg} />);
    expect(await screen.findByRole('heading', { name: 'Микрофон недоступен внутри Telegram' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Открыть в браузере/ }));
    expect(tg.calls).toContain('open:' + INVITE);
    fireEvent.click(screen.getByRole('button', { name: /Войти без микрофона/ }));
    await screen.findByText('встреча');
    expect(api.telegramEnter).toHaveBeenCalledTimes(1);
    expect(api.meetings[0]).toMatchObject({ choices: { micOn: false, cameraOn: false } });
  });

  it('отказ службы — экраном с текстом отказа, повтор и «Закрыть»', async () => {
    api.telegramEnter.mockRejectedValueOnce(
      new ApiError(403, 'TELEGRAM_NOT_MEMBER', 'Вы не состоите в чате, к которому привязана встреча'),
    );
    const tg = shell();
    render(<TelegramApp shell={tg} />);
    expect(await screen.findByText('Вы не состоите в чате, к которому привязана встреча')).toBeVisible();
    expect(tg.calls).toContain('haptic:error');
    fireEvent.click(screen.getByRole('button', { name: /Закрыть/ }));
    expect(tg.calls).toContain('close');
    fireEvent.click(screen.getByRole('button', { name: /Повторить/ }));
    await screen.findByText('встреча');
  });

  it('уже во встрече на этом устройстве — «Выйти оттуда и войти сюда»', async () => {
    api.join.mockRejectedValueOnce(
      new ApiError(409, 'ALREADY_IN_MEETING', 'Вы уже во встрече «Другая»', {
        roomId: 'other',
        title: 'Другая',
      }),
    );
    render(<TelegramApp shell={shell()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Выйти оттуда и войти сюда' }));
    await screen.findByText('встреча');
    await waitFor(() => expect(api.join).toHaveBeenLastCalledWith(ROOM, expect.anything(), 'other'));
  });

  it('вне Telegram — объяснение и дорога в Cord', () => {
    render(<TelegramApp shell={null} />);
    expect(screen.getByRole('heading', { name: 'Откройте встречу из Telegram' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Открыть Cord' })).toHaveAttribute('href', '/');
    expect(api.telegramEnter).not.toHaveBeenCalled();
  });
});
