import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { YandexApi } from '../core/services';
import { YandexIntegration } from './YandexIntegration';

/*
  Токен — способ подключиться, а не отдельная кнопка рядом с «Подключить» (владелец, после R128): строка
  аккаунта показывает одно «Подключить», а «У меня уже есть токен доступа» живёт внутри входа — под QR.
*/

afterEach(cleanup);

function fakeApi() {
  return {
    status: vi.fn(async () => ({ connected: false, name: null })),
    start: vi.fn(async () => ({
      id: 'code-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://ya.ru/device',
      expiresAt: Date.now() + 300000,
      interval: 5,
      status: 'pending' as const,
    })),
    poll: vi.fn((_id: string): Promise<unknown> => new Promise(() => {})),
    cancel: vi.fn(async () => undefined),
    connectToken: vi.fn(async () => ({ connected: true, name: 'Гость Яндекса' })),
    disconnect: vi.fn(),
  };
}

function mount(api: ReturnType<typeof fakeApi>, onStoredTokenChange = vi.fn(), storedToken = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <YandexIntegration
        api={api as unknown as YandexApi}
        roomId="room"
        storedToken={storedToken}
        onStoredTokenChange={onStoredTokenChange}
      />
    </QueryClientProvider>,
  );
  return onStoredTokenChange;
}

describe('Яндекс Музыка: подключение', () => {
  it('у строки — одно «Подключить», токена рядом нет', async () => {
    mount(fakeApi());
    expect(await screen.findByRole('button', { name: 'Подключить' })).toBeInTheDocument();
    expect(screen.queryByText('У меня уже есть токен доступа')).toBeNull();
  });

  it('токен — внутри входа: под QR, подключает и закрывает вход', async () => {
    const api = fakeApi();
    const stored = mount(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Подключить' }));
    fireEvent.click(await screen.findByText('У меня уже есть токен доступа'));
    const token = 'y0_' + 'x'.repeat(40);
    fireEvent.change(screen.getByLabelText('Токен Яндекс Музыки'), { target: { value: token } });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить токен' }));
    await waitFor(() => expect(api.connectToken).toHaveBeenCalledWith(token));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Отменить вход' })).toBeNull());
    expect(stored).toHaveBeenCalledWith(token);
    expect(screen.getByText('Гость Яндекса')).toBeInTheDocument();
  });
});

describe('токен не отваливается после перезахода (R157)', () => {
  it('вход по QR в комнате кладёт токен и на устройство', async () => {
    const api = fakeApi();
    // Опрос без паузы: ждать пять секунд интервала Яндекса тесту незачем.
    api.start.mockImplementation(async () => ({
      id: 'code-1',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://ya.ru/device',
      expiresAt: Date.now() + 300000,
      interval: 0,
      status: 'pending' as const,
    }));
    api.poll.mockImplementation(async () => ({
      status: 'connected',
      token: 'y0_from_qr',
      name: 'Слушатель',
    }));
    const stored = mount(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Подключить' }));
    await waitFor(() => expect(stored).toHaveBeenCalledWith('y0_from_qr'), { timeout: 20000 });
  });

  it('сохранённый токен подключается к новой комнате сам, один раз', async () => {
    const api = fakeApi();
    mount(api, vi.fn(), 'y0_saved_token');
    await waitFor(() => expect(api.connectToken).toHaveBeenCalledWith('y0_saved_token'));
    expect(await screen.findByText('Гость Яндекса')).toBeInTheDocument();
    expect(api.connectToken).toHaveBeenCalledTimes(1);
  });

  it('без права или с протухшим токеном — тихо, «Подключить» остаётся', async () => {
    const api = fakeApi();
    api.connectToken.mockRejectedValue(new Error('403'));
    mount(api, vi.fn(), 'y0_saved_token');
    await waitFor(() => expect(api.connectToken).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Подключить' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
