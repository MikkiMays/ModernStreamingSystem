import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ListPlus, Search, ExternalLink, LoaderCircle, LogOut, Info } from 'lucide-react';
import QRCode from 'qrcode';
import { YandexApi, type MusicState, type YandexAuthorization, type YandexTrack } from '../core/services';
import type { Meeting } from '../core/meeting';
import { IconButton } from './primitives';

export function YandexIntegration({
  meeting,
  update,
  storedToken,
  onStoredTokenChange,
}: {
  meeting: Meeting;
  update: (state: MusicState) => void;
  storedToken: string;
  onStoredTokenChange: (token: string) => void;
}) {
  return (
    <section className="service-card yandex-card">
      <div className="service-heading">
        <span className="service-icon yandex">Я</span>
        <div>
          <h3>Яндекс Музыка</h3>
          <p>Поиск и музыка для всей комнаты</p>
        </div>
        <details className="integration-info">
          <summary aria-label="Как подключить Яндекс Музыку">
            <Info size={18} />
          </summary>
          <p>
            Войдите в Яндекс, чтобы искать и слушать треки. В комнате используется один аккаунт, который
            участники выбирают по договорённости. Подключить или сменить его может любой участник, которому
            создатель разрешил интеграции.
          </p>
        </details>
      </div>
      <YandexAccount
        meeting={meeting}
        update={update}
        storedToken={storedToken}
        onStoredTokenChange={onStoredTokenChange}
      />
    </section>
  );
}
function YandexAccount({
  meeting,
  update,
  storedToken,
  onStoredTokenChange,
}: {
  meeting: Meeting;
  update: (state: MusicState) => void;
  storedToken: string;
  onStoredTokenChange: (token: string) => void;
}) {
  const api = useMemo(() => new YandexApi(meeting.admission), [meeting]);
  const client = useQueryClient();
  const key = useMemo(() => ['yandex', meeting.admission.roomId], [meeting.admission.roomId]);
  const account = useQuery({ queryKey: key, queryFn: api.status, retry: false, refetchInterval: 3000 });
  const [auth, setAuth] = useState<YandexAuthorization | null>(null);
  const [qr, setQr] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [tracks, setTracks] = useState<YandexTrack[] | null>(null);
  const [token, setToken] = useState(storedToken);
  const [notice, setNotice] = useState('');
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
          client.setQueryData(key, { connected: value.connected, name: value.name });
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
    void QRCode.toDataURL(auth.verificationUrl, {
      width: 180,
      margin: 1,
      color: { dark: '#17151f', light: '#ffffff' },
    }).then((value) => {
      if (!disposed) setQr(value);
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [api, auth, client, key]);
  const connect = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const saved = storedToken.trim();
      if (saved) {
        try {
          client.setQueryData(key, await api.connectToken(saved));
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
  return (
    <>
      {account.isLoading ? (
        <p role="status">Проверяем подключение…</p>
      ) : account.data?.connected && !auth ? (
        <>
          <div className="integration-account">
            <span>
              <strong>{account.data.name}</strong>
              <small>Подключён к этой комнате</small>
            </span>
            {
              <IconButton
                label="Отключить Яндекс Музыку"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    client.setQueryData(key, await api.disconnect());
                    setTracks(null);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <LogOut size={18} />
              </IconButton>
            }
          </div>
          <button className="button ghost full" disabled={busy} onClick={() => void connect()}>
            Сменить аккаунт
          </button>
          <form
            className="integration-search"
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy || !query.trim()) return;
              setBusy(true);
              setError('');
              setNotice('');
              try {
                setTracks(await api.search(query.trim()));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label htmlFor={`music-search`}>Название, исполнитель или ссылка на трек</label>
            <div>
              <input
                id={`music-search`}
                value={query}
                maxLength={300}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Найдите музыку"
              />
              <IconButton label="Найти в Яндекс Музыке" type="submit" disabled={busy || !query.trim()}>
                {busy ? <LoaderCircle className="spin" size={18} /> : <Search size={18} />}
              </IconButton>
            </div>
          </form>
          {tracks &&
            (tracks.length ? (
              <ol className="integration-results">
                {tracks.map((track) => (
                  <li key={track.id}>
                    <span>
                      <strong>{track.title}</strong>
                      <small>
                        {track.artist} · {Math.floor(track.duration / 60)}:
                        {String(Math.floor(track.duration % 60)).padStart(2, '0')}
                      </small>
                    </span>
                    <IconButton
                      label={`Добавить в очередь: ${track.title}`}
                      disabled={!!adding || !track.available}
                      onClick={async () => {
                        setAdding(track.id);
                        setError('');
                        try {
                          update(await api.enqueue(track.id));
                          setNotice(`Добавлено: ${track.title}`);
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setAdding(null);
                        }
                      }}
                    >
                      {adding === track.id ? (
                        <LoaderCircle className="spin" size={18} />
                      ) : (
                        <ListPlus size={18} />
                      )}
                    </IconButton>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">Треки не найдены. Попробуйте другое название.</p>
            ))}
        </>
      ) : (
        <>
          {auth ? (
            <div className="yandex-auth">
              {qr && <img src={qr} alt="QR-код страницы входа Яндекса" width={180} height={180} />}
              <p>Откройте страницу Яндекса и введите код:</p>
              <strong className="device-code">{auth.userCode}</strong>
              <a
                className="button primary full"
                href={auth.verificationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Войти в Яндекс <ExternalLink size={16} />
              </a>
              <p className="form-footnote">
                Подтверждение появится здесь автоматически. Код действует 5 минут.
              </p>
              <button
                className="button ghost"
                onClick={() => {
                  void api.cancel(auth.id).catch(() => {});
                  setAuth(null);
                }}
              >
                Отменить вход
              </button>
            </div>
          ) : (
            <>
              <button className="button primary full" disabled={busy} onClick={() => void connect()}>
                {busy ? <LoaderCircle className="spin" size={18} /> : <ExternalLink size={18} />}
                {storedToken.trim() ? 'Подключить сохранённый токен' : 'Подключить Яндекс Музыку'}
              </button>
              <p className="form-footnote">
                Пароль вводится на странице Яндекса. Для полных треков нужен аккаунт с доступом к ним.
                Участники комнаты смогут ставить музыку через этот аккаунт.
              </p>
              <details className="token-option">
                <summary>У меня уже есть токен доступа</summary>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const value = token.trim();
                    if (!value) return;
                    setBusy(true);
                    setError('');
                    try {
                      client.setQueryData(key, await api.connectToken(value));
                      setToken('');
                      onStoredTokenChange(value);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <label>
                    Токен Яндекс Музыки
                    <input
                      type="password"
                      autoComplete="off"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      maxLength={1000}
                    />
                  </label>
                  <button className="button secondary full" disabled={busy || token.trim().length < 20}>
                    Подключить токен
                  </button>
                </form>
              </details>
            </>
          )}
          <p className="form-footnote">Используется неофициальный открытый коннектор Яндекс Музыки.</p>
        </>
      )}
      {notice && (
        <p className="integration-notice" role="status">
          {notice}
        </p>
      )}
      {(error || account.isError) && (
        <p className="form-error" role="alert">
          {error || (account.error as Error).message}
        </p>
      )}
    </>
  );
}
