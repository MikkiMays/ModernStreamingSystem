import { useEffect, useRef, useState } from 'react';
import { ArrowRight, LoaderCircle, Plus, Server, Settings } from 'lucide-react';
import type { Capabilities } from '../api/types';
import { IconButton, Logo, ThemeButton, type Theme } from './primitives';
import {
  currentServerUrl,
  findServer,
  readServers,
  saveServer,
  serverLabel,
  type SavedServer,
} from '../core/servers';
import { describeFailure, openConnection, serverInfo, type Attempt } from '../core/session';
import { ensureNotificationAudio } from '../core/sounds';
import { notifyDesktop } from '../core/desktop';
import { ConnectionStatus, ServerDialog } from './ServerDialog';

/**
 * The first screen, and on a closed server the only one until it succeeds. Nothing about
 * meetings is shown before the server has answered: favourites belong to a server, and the
 * client has no business displaying one server's rooms while connected to another.
 *
 * In a browser this is the server that served the page — a browser cannot address any other,
 * so the other entries here are bookmarks and choosing one goes there. In the Windows client
 * the native shell owns the list and can reach all of them.
 */
export function Connect({
  theme,
  setTheme,
  onConnected,
}: {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  onConnected: () => void;
}) {
  const desktop = !!window.chrome?.webview;
  const [servers, setServers] = useState<SavedServer[]>(readServers);
  const here = currentServerUrl();
  const [password, setPassword] = useState(() => findServer(here)?.password ?? '');
  const [autoConnect, setAutoConnect] = useState(() => findServer(here)?.autoConnect !== false);
  const [info, setInfo] = useState<Capabilities | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{ intent: 'connect' | 'save'; server?: SavedServer } | null>(null);
  const started = useRef(false);

  const connect = async (secret = password) => {
    setBusy(true);
    ensureNotificationAudio();
    const result = await openConnection(secret);
    setAttempt(result);
    setBusy(false);
    if (result.ok) {
      saveServer({ url: here, name: findServer(here)?.name ?? '', password: secret, autoConnect });
      onConnected();
    }
    return result.ok;
  };

  useEffect(() => {
    let active = true;
    void serverInfo()
      .then((capabilities) => {
        if (!active) return;
        setInfo(capabilities);
        // Connecting to an open server asks nothing, so waiting for a click would be a step
        // with no question in it. A closed one waits unless this device kept the password.
        const saved = findServer(here);
        const ready = !capabilities.passwordRequired || !!saved?.password;
        if (saved?.autoConnect !== false && ready && !started.current) {
          started.current = true;
          void connect(saved?.password ?? '');
        }
      })
      .catch((error) => {
        if (active) setAttempt({ ok: false, detail: describeFailure(error) });
      });
    return () => {
      active = false;
    };
    // The handshake belongs to this mount; re-running it on every keystroke would be wrong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What you called this server wins over what it calls itself: a list of five servers all
  // named "Cord" is why the label exists.
  const saved = findServer(here);
  const name = saved?.name.trim() || info?.name || serverLabel({ url: here, name: '' });
  const waiting = !info && !attempt;
  return (
    <div className="connect-page">
      <header className="app-header">
        <Logo />
        <div className="header-end">
          <span className="header-note">Подключение к серверу</span>
          <ThemeButton theme={theme} setTheme={setTheme} />
        </div>
      </header>
      <main className="connect-main">
        {!desktop && (
          <section className="connect-list" aria-label="Сохранённые серверы">
            <div className="connect-list-heading">
              <span>СЕРВЕРЫ</span>
              <IconButton
                label="Добавить сервер"
                className="connect-add"
                onClick={() => setDialog({ intent: 'save' })}
              >
                <Plus size={19} />
              </IconButton>
            </div>
            <ul>
              {servers.map((server) => (
                <li key={server.url} className={server.url === here ? 'current' : ''}>
                  <button
                    className="connect-server"
                    onClick={() => {
                      if (server.url === here) return;
                      saveServer(server);
                      location.assign(server.url);
                    }}
                  >
                    <span className="connect-server-icon">
                      <Server size={17} />
                    </span>
                    <span>
                      <strong>{serverLabel(server)}</strong>
                      <small>{server.url === here ? 'Открыт сейчас' : new URL(server.url).host}</small>
                    </span>
                  </button>
                  <IconButton
                    label={`Настроить «${serverLabel(server)}»`}
                    onClick={() => setDialog({ intent: 'save', server })}
                  >
                    <Settings size={17} />
                  </IconButton>
                </li>
              ))}
            </ul>
            <p className="form-footnote">
              Браузер может открыть только тот сервер, который его обслуживает. Выбор другого из списка
              откроет его страницу; список хранится отдельно у каждого сервера.
            </p>
          </section>
        )}
        <section className="connect-card" aria-labelledby="connect-title">
          <span className="connect-badge" aria-hidden="true">
            <Server size={26} />
          </span>
          <h1 id="connect-title">{waiting ? 'Ищем сервер…' : name}</h1>
          <p className="muted">{new URL(here).host}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            {info?.passwordRequired && (
              <label>
                Пароль сервера
                <input
                  type="password"
                  value={password}
                  maxLength={200}
                  autoComplete="current-password"
                  autoFocus
                  placeholder="Спросите у того, кто дал адрес"
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            )}
            <label className="check-setting">
              <input
                type="checkbox"
                checked={autoConnect}
                onChange={(event) => {
                  setAutoConnect(event.target.checked);
                  saveServer({
                    url: here,
                    name: findServer(here)?.name ?? '',
                    password: findServer(here)?.password ?? '',
                    autoConnect: event.target.checked,
                  });
                }}
              />
              <span>Подключаться автоматически при запуске</span>
            </label>
            <button className="button primary full" type="submit" disabled={busy || waiting}>
              {busy ? (
                <>
                  <LoaderCircle className="spin" size={18} /> Подключаемся…
                </>
              ) : (
                <>
                  Подключиться <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
          <div className="connect-status-row">
            <ConnectionStatus attempt={busy ? null : attempt} />
            {desktop ? (
              <button className="text-button" onClick={() => notifyDesktop('servers.open')}>
                Другой сервер…
              </button>
            ) : (
              <button className="text-button" onClick={() => setDialog({ intent: 'connect' })}>
                Другой сервер…
              </button>
            )}
          </div>
        </section>
      </main>
      <ServerDialog
        open={!!dialog}
        intent={dialog?.intent ?? 'save'}
        server={dialog?.server}
        onOpenChange={(open) => !open && setDialog(null)}
        onSaved={setServers}
        onConnected={onConnected}
      />
    </div>
  );
}
