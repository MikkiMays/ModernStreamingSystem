import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, LogOut, MoreHorizontal, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { YandexApi, YandexAccount } from '../core/services';
import { t as translate } from '../i18n';
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuTrigger } from './kit';
import { SourceMark } from './MusicPlayer';
import { YandexDeviceLogin, type DeviceFlow } from './music/YandexDeviceLogin';

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

/**
 * Строка «Яндекс Музыка» в панели музыки (R128 — компактной строкой): знак, имя и кто подключён;
 * справа «Подключить» или «⋯» со «Сменить аккаунт» и «Отключить». «Подключить» открывает вход: QR, а
 * под ним — «У меня уже есть токен доступа» (тихая раскрывашка). Токен — способ того же подключения,
 * поэтому отдельной кнопкой рядом с «Подключить» его нет (владелец, после R128).
 */
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
  const { t } = useTranslation();
  const id = useId();
  const client = useQueryClient();
  const account = useYandexAccount(api, roomId, true);
  /** Идёт вход по коду устройства (QR) — в аккаунт комнаты. */
  const [qr, setQr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [token, setToken] = useState(storedToken);
  const [notice, setNotice] = useState('');
  const save = (value: YandexAccount) => client.setQueryData(['yandex', roomId], value);
  const flow = useMemo<DeviceFlow>(() => ({ start: api.start, poll: api.poll, cancel: api.cancel }), [api]);
  useEffect(() => {
    setToken(storedToken);
  }, [storedToken]);
  /*
    Сохранённый на устройстве токен подключается к комнате сам (R157, Р-43): раньше он уходил в
    комнату только при включении музыки или по «Подключить», и в новой встрече человек снова видел
    «не подключено». Один раз на комнату; без права (403) или с протухшим токеном — тихо, кнопка
    «Подключить» остаётся и объяснит сама.
  */
  const tried = useRef<string | null>(null);
  const saved = storedToken.trim();
  useEffect(() => {
    if (!saved || account.data?.connected !== false || tried.current === roomId) return;
    tried.current = roomId;
    void api
      .connectToken(saved)
      .then((value) => client.setQueryData(['yandex', roomId], value))
      .catch(() => {
        /* Права нет или токен устарел — подключат руками. */
      });
  }, [saved, account.data?.connected, roomId, api, client]);
  const connect = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = storedToken.trim();
      if (saved) {
        try {
          save(await api.connectToken(saved));
          setNotice(t(($) => $.music.yandex.tokenConnected));
          return;
        } catch {
          setError(t(($) => $.music.yandex.tokenStale));
        }
      }
      setQr(true);
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
  const connected = !!account.data?.connected && !qr;
  return (
    <section className="music-account" aria-labelledby={`${id}-title`}>
      <div className="music-account__row">
        <SourceMark source="yandex" />
        <div className="music-account__text">
          <span className="music-account__title" id={`${id}-title`}>
            {t(($) => $.music.sources.yandex)}
          </span>
          <span className="music-account__hint" data-on={connected || undefined}>
            {account.isLoading
              ? t(($) => $.music.yandex.checking)
              : connected
                ? (account.data?.name ?? t(($) => $.music.yandex.badge))
                : t(($) => $.settings.accounts.disconnected)}
          </span>
        </div>
        {connected ? (
          <Menu>
            <MenuTrigger
              disabled={busy}
              render={
                <IconButton size="sm" className="music-account__more" label={t(($) => $.music.yandex.more)}>
                  <MoreHorizontal />
                </IconButton>
              }
            />
            <MenuContent align="end">
              <MenuItem icon={<RefreshCw />} onClick={() => void connect()}>
                {t(($) => $.music.yandex.switch)}
              </MenuItem>
              <MenuItem icon={<LogOut />} destructive onClick={() => void disconnect()}>
                {t(($) => $.music.yandex.disconnect)}
              </MenuItem>
            </MenuContent>
          </Menu>
        ) : (
          !qr &&
          !account.isLoading && (
            <Button size="sm" loading={busy} onClick={() => void connect()}>
              {t(($) => $.music.yandex.connect)}
            </Button>
          )
        )}
      </div>
      {qr && (
        <div className="music-account__auth">
          <YandexDeviceLogin
            flow={flow}
            onDone={(result) => {
              setQr(false);
              setError('');
              save({ connected: true, name: result.name ?? null });
              // Вход по QR отдаёт токен и устройству (R157): следующая встреча подключится сама.
              if (result.token) onStoredTokenChange(result.token);
              // Опрос живёт вне отрисовки — текст рождается в момент ответа, глобальным переводом.
              setNotice(translate(($) => $.music.yandex.connected));
            }}
          />
          <details className="music-account__token">
            <summary>
              <ChevronRight className="music-account__chevron" aria-hidden="true" />
              {t(($) => $.music.yandex.haveToken)}
            </summary>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const value = token.trim();
                if (!value) return;
                setBusy(true);
                setError('');
                try {
                  save(await api.connectToken(value));
                  setQr(false);
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
                {t(($) => $.music.yandex.tokenLabel)}
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
                {t(($) => $.music.yandex.connectToken)}
              </Button>
            </form>
          </details>
          <Button size="sm" variant="quiet" onClick={() => setQr(false)}>
            {t(($) => $.music.yandex.cancel)}
          </Button>
        </div>
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
