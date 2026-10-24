import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';

vi.mock('../core/session', () => ({ serverInfo: async () => ({ maxParticipants: 10, fileMaxBytes: 1024 }) }));

import { Sidebar } from './Sidebar';

/*
  Ctrl+V скриншота в чате (R94): картинка ложится превью над полем, как у GPT и Claude, и уходит по
  Enter вместе с текстом — сначала файл, затем подпись; Shift+Enter — перенос строки.
*/

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

function fakeMeeting() {
  const order: string[] = [];
  const meeting = {
    admission: { roomId: 'room', participantId: 'self', credential: 'token' },
    snapshot: new Store({
      id: 'room',
      participants: [{ id: 'self', name: 'Майя', status: 'ACTIVE', role: 'OWNER' }],
      messages: [],
    }),
    fileRevision: new Store(0),
    ended: new Store(null),
    draft: new Store(''),
    media: { tracks: new Store([]) },
    uploader: {
      state: new Store({ name: '', progress: 0, status: 'idle' }),
      send: vi.fn(async (file: File) => {
        order.push(`file:${file.name}`);
        return true;
      }),
      pause: vi.fn(),
      resume: vi.fn(),
      cancel: vi.fn(),
    },
    api: { files: vi.fn(async () => []), download: vi.fn(), cancel: vi.fn() },
    command: vi.fn(async (type: string, text: string) => {
      order.push(`${type}:${text}`);
    }),
    refresh: vi.fn(),
  };
  return {
    meeting: meeting as unknown as Meeting,
    order,
    uploader: meeting.uploader,
    command: meeting.command,
  };
}

function show(meeting: Meeting) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Sidebar meeting={meeting} panel="chat" setPanel={vi.fn()} onClose={vi.fn()} onInvite={vi.fn()} />
    </QueryClientProvider>,
  );
}

function paste(field: HTMLElement, files: File[], text = '') {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.assign(event, {
    clipboardData: {
      files,
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
  act(() => {
    field.dispatchEvent(event);
  });
  return event;
}

const field = () => screen.getByRole('textbox', { name: 'Сообщение' });
const screenshot = () => new File([new Uint8Array(300)], 'image.png', { type: 'image/png' });

describe('вставка скриншота в чат (R94)', () => {
  it('Ctrl+V картинки — превью над полем с именем, размером и «Убрать»; текст вставляется как обычно', () => {
    const { meeting, uploader } = fakeMeeting();
    show(meeting);
    expect(paste(field(), [], 'просто текст').defaultPrevented).toBe(false);
    expect(screen.queryByRole('list', { name: 'Вложения к сообщению' })).toBeNull();
    expect(paste(field(), [screenshot()]).defaultPrevented).toBe(true);
    const list = screen.getByRole('list', { name: 'Вложения к сообщению' });
    const item = within(list).getByRole('listitem');
    expect(item).toHaveTextContent(/^screenshot-\d{4}-\d{2}-\d{2}-\d{6}\.png/);
    expect(item).toHaveTextContent('1 КиБ');
    expect(item.querySelector('img')).toHaveAttribute('src', 'blob:preview');
    // Пока не нажали «Отправить», ничего не грузится.
    expect(uploader.send).not.toHaveBeenCalled();
    fireEvent.click(within(item).getByRole('button', { name: /^Убрать screenshot-/ }));
    expect(screen.queryByRole('list', { name: 'Вложения к сообщению' })).toBeNull();
  });

  it('Enter отправляет скриншот, затем подпись к нему; Shift+Enter — перенос строки', async () => {
    const { meeting, order } = fakeMeeting();
    show(meeting);
    paste(field(), [screenshot()]);
    fireEvent.change(field(), { target: { value: 'Вот что у меня на экране' } });
    fireEvent.keyDown(field(), { key: 'Enter', shiftKey: true });
    expect(order).toEqual([]);
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(order).toHaveLength(2));
    expect(order[0]).toMatch(/^file:screenshot-.*\.png$/);
    expect(order[1]).toBe('message.send:Вот что у меня на экране');
    expect(screen.queryByRole('list', { name: 'Вложения к сообщению' })).toBeNull();
    expect(field()).toHaveValue('');
  });

  it('только скриншот, без текста — «Отправить» доступна и уходит один файл', async () => {
    const { meeting, order } = fakeMeeting();
    show(meeting);
    const send = screen.getByRole('button', { name: 'Отправить сообщение' });
    expect(send).toBeDisabled();
    paste(field(), [screenshot()]);
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => expect(order).toHaveLength(1));
    expect(order[0]).toMatch(/^file:screenshot-/);
  });

  it('файл не дошёл — подпись не уходит и остаётся в поле', async () => {
    const { meeting, uploader, command } = fakeMeeting();
    uploader.send.mockResolvedValueOnce(false);
    show(meeting);
    paste(field(), [screenshot()]);
    fireEvent.change(field(), { target: { value: 'Подпись' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    await waitFor(() => expect(uploader.send).toHaveBeenCalled());
    expect(command).not.toHaveBeenCalled();
    expect(field()).toHaveValue('Подпись');
  });

  it('слишком большой файл не ложится в превью: отказ словами сразу (T02)', async () => {
    const { meeting } = fakeMeeting();
    show(meeting);
    // Предел файла — от сервера (`capabilities.fileMaxBytes`): ждём его ответа.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    paste(field(), [new File([new Uint8Array(4096)], 'image.png', { type: 'image/png' })]);
    expect(screen.queryByRole('list', { name: 'Вложения к сообщению' })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Во встречу можно отправить файл до');
  });
});
