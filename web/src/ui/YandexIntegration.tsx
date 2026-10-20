import { useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Music } from 'lucide-react';
import QRCode from 'qrcode';
import type { YandexApi, YandexAccount, YandexAuthorization } from '../core/services';
import { Badge, Button } from './kit';

/**
 * Аккаунт Яндекс Музыки комнаты — один на всех, и знают о нём двое: эта строка и поле поиска
 * (ищет в Яндексе, только когда аккаунт подключён). Ключ и опрос общие, поэтому запрос один.
 *
 * Аккаунт меняется, только когда его подключают или отключают, а эта строка пишет итог своих
 * действий прямо в кэш. Опрос раз в три секунды был запросом на участника за значение, которое
 * почти не двигается, — теперь раз в тридцать.
 */
export function useYandexAccount(api: YandexApi, roomId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['yandex', roomId],
    queryFn: api.status,
    retry: false,
    refetchInterval: 30000,
    enabled,
  });
}

/** Строка «Яндекс Музыка» в панели музыки: кто подключён, вход по коду или токеном. */
export function YandexIntegration({
  api,
  roomId,
  storedToken,
  onStoredTokenChange,
}: {
  api: YandexApi;
  roomId: string;
  storedToken: string;
  onStoredTokenChange: (token: string) => void;
}) {
  const id = useId();
  const client = useQueryClient();
  const account = useYandexAccount(api, roomId, true);
  const [auth, setAuth] = useState<YandexAuthorization | null>(null);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState(storedToken);
  const [notice, setNotice] = useState('');
  const save = (value: YandexAccount) => client.setQueryData(['yandex', roomId], value);
  useEffect(() => {
    setToken(storedToken);
  }, [storedToken]);
  useEffect(() => {
    if (!auth || auth.status !== 'pending') return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api.poll(auth.id);
        if (disposed) return;
        if (value.status === 'connected') {
          setAuth(null);
          client.setQueryData(['yandex', roomId], { connected: value.connected, name: value.name });
          setNotice('Аккаунт подключён');
          return;
        }
        if (Date.now() >= value.expiresAt) {
          setAuth(null);
          setError('Код истёк. Получите новый');
          return;
        }
        timer = setTimeout(() => void poll(), value.interval * 1000);
      } catch (e) {
        if (!disposed) {
          setAuth(null);
          setError((e as Error).message);
        }
      }
    };
    timer = setTimeout(() => void poll(), auth.interval * 1000);
    // QR рисуется тёмным по белому в обеих темах: так его читает любая камера.
    void QRCode.toDataURL(auth.verificationUrl, { width: 176, margin: 1 }).then((value) => {
      if (!disposed) setQr(value);
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [api, auth, client, roomId]);
  const connect = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = storedToken.trim();
      if (saved) {
        try {
          save(await api.connectToken(saved));
          setNotice('Подключено сохранённым токеном');
          return;
        } catch {
          setError('Сохранённый токен больше не подходит. Войдите в Яндекс или введите новый токен.');
        }
      }
      setAuth(await api.start());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      save(await api.disconnect());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const connected = !!account.data?.connected && !auth;
  return (
    <section className="music-account" aria-labelledby={`${id}-title`}>
      <div className="music-account__row">
        <span className="music-account__icon" aria-hidden="true">
          <Music size={18} />
        </span>
        <div className="music-account__text">
          <span className="music-account__title" id={`${id}-title`}>
            Яндекс Музыка
          </span>
          <span className="music-account__hint">
            {account.isLoading
              ? 'Проверяем подключение…'
              : connected
                ? account.data?.name
                : 'Аккаунт комнаты: через него ищут и ставят треки все участники'}
          </span>
        </div>
        {connected ? (
          <Badge variant="success">Подключён</Badge>
        ) : (
          !auth &&
          !account.isLoading && (
            <Button size="sm" variant="primary" loading={busy} onClick={() => void connect()}>
              Подключить
            </Button>
          )
        )}
      </div>
      {connected && (
        <div className="music-account__actions">
          <Button size="sm" variant="quiet" disabled={busy} onClick={() => void connect()}>
            Сменить аккаунт
          </Button>
          <Button
            size="sm"
            variant="quiet"
            className="music-account__off"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            Отключить
          </Button>
        </div>
      )}
      {auth && (
        <div className="music-account__auth">
          {qr && <img src={qr} alt="QR-код страницы входа Яндекса" width={176} height={176} />}
          <p>Откройте страницу Яндекса и введите код:</p>
          <strong className="music-account__code">{auth.userCode}</strong>
          <a
            className="ui-button ui-button--primary ui-button--md"
            href={auth.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="ui-button__label">Войти в Яндекс</span>
            <ExternalLink size={16} aria-hidden="true" />
          </a>
          <p className="music-account__note">Подтверждение появится здесь само. Код действует 5 минут.</p>
          <Button
            size="sm"
            variant="quiet"
            onClick={() => {
              void api.cancel(auth.id).catch(() => {});
              setAuth(null);
            }}
          >
            Отменить вход
          </Button>
        </div>
      )}
      {!connected && !auth && !account.isLoading && (
        <details className="music-account__token">
          <summary>У меня уже есть токен доступа</summary>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const value = token.trim();
              if (!value) return;
              setBusy(true);
              setError('');
              try {
                save(await api.connectToken(value));
                setToken('');
                onStoredTokenChange(value);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="music-account__label" htmlFor={`${id}-token`}>
              Токен Яндекс Музыки
            </label>
            <input
              id={`${id}-token`}
              className="ui-input"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              maxLength={1000}
            />
            <Button size="sm" disabled={busy || token.trim().length < 20} type="submit">
              Подключить токен
            </Button>
          </form>
        </details>
      )}
      {!connected && !auth && (
        <p className="music-account__note">
          Пароль вводится на странице Яндекса. Для полных треков нужен аккаунт с подпиской. Работает через
          неофициальный открытый коннектор Яндекс Музыки.
        </p>
      )}
      {notice && (
        <p className="music-account__notice" role="status">
          {notice}
        </p>
      )}
      {(error || account.isError) && (
        <p className="music-account__error" role="alert">
          {error || (account.error as Error).message}
        </p>
      )}
    </section>
  );
}
