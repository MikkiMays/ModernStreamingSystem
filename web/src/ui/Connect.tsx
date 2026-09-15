import { useEffect, useRef, useState } from 'react';
import { ArrowRight, LoaderCircle, Plus, Server, Settings } from 'lucide-react';
import type { Capabilities } from '../api/types';
import { DownloadLink, IconButton, Logo, ThemeButton, useStore, type Theme } from './primitives';
import {
  currentServerUrl,
  findServer,
  readServers,
  saveServer,
  serverLabel,
  type SavedServer,
} from '../core/servers';
import { describeFailure, openConnection, serverInfo, type Attempt } from '../core/session';
import { checkHealth, health, type Health } from '../core/health';
import { ensureNotificationAudio } from '../core/sounds';
import { notifyDesktop } from '../core/desktop';
import { ConnectionStatus, ServerDialog } from './ServerDialog';

/**
 * The first screen, and until the handshake succeeds the only one. Nothing about meetings is
 * shown before a server has answered: favourites belong to a server, and a client has no
 * business displaying one server's rooms while connected to another.
 *
 * It is a chooser rather than a form. With nothing saved there is one thing to do and it fills
 * the card; with servers saved, each is a row you pick, with a dot saying whether it is
 * answering and a gear for changing or forgetting it.
 *
 * In a browser only the server that served this page will talk to us — the core refuses a
 * foreign `Origin` — so choosing another goes there. The Windows client owns its list natively
 * and can reach all of them.
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
  const here = currentServerUrl();
  const [servers, setServers] = useState<SavedServer[]>(readServers);
  const [chosen, setChosen] = useState(here);
  const [password, setPassword] = useState(() => findServer(here)?.password ?? '');
  const [autoConnect, setAutoConnect] = useState(() => findServer(here)?.autoConnect !== false);
  const [info, setInfo] = useState<Capabilities | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{ server?: SavedServer } | null>(null);
  const reachable = useStore(health);
  const started = useRef(false);

  useEffect(() => {
    for (const server of servers) void checkHealth(server.url);
  }, [servers]);

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
        // Connecting to an open server asks nothing, so waiting for a click on a screen with
        // no question on it would be a step for its own sake. A closed one waits unless this
        // device kept the password.
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
    // Deliberately empty: the handshake belongs to this mount. Listing the password or the
    // saved entry here would re-run it on every keystroke.
  }, []);

  const open = (server: SavedServer) => {
    if (server.url === here) {
      setChosen(here);
      return;
    }
    // Another origin cannot answer this page, so choosing it means going there. The desktop
    // has its own list and no such limit.
    saveServer(server);
    if (desktop) notifyDesktop('servers.open');
    else location.assign(server.url);
  };

  const saved = findServer(here);
  const name = saved?.name.trim() || info?.name || serverLabel({ url: here, name: '' });
  const waiting = !info && !attempt;
  const empty = servers.length === 0;
  return (
    <div className="connect-page">
      <header className="app-header">
        <Logo />
        <div className="header-end">
          <span className="header-note">Подключение к серверу</span>
          <DownloadLink />
          <ThemeButton theme={theme} setTheme={setTheme} />
        </div>
      </header>
      <main className="connect-main">
        <section className="connect-card" aria-labelledby="connect-title">
          <span className="connect-badge" aria-hidden="true">
            <Server size={26} />
          </span>
          <h1 id="connect-title">{empty ? 'Добавьте сервер' : 'Выберите сервер'}</h1>
          <p className="muted">
            {empty
              ? 'Cord подключается к серверу, на котором идут встречи. Адрес даёт тот, кто его поднял.'
              : 'Встречи и избранное принадлежат серверу. Сначала подключение, потом комнаты.'}
          </p>
          {empty ? (
            <button className="button primary full connect-invite" onClick={() => setDialog({})}>
              <Plus size={19} /> Добавить сервер
            </button>
          ) : (
            <>
              <ul className="server-list">
                {servers.map((server) => (
                  <li key={server.url} className={server.url === chosen ? 'current' : ''}>
                    <button className="server-choice" onClick={() => open(server)}>
                      <span className="connect-server-icon">
                        <Server size={17} />
                      </span>
                      <span className="server-choice-text">
                        <strong>
                          {serverLabel(server)}
                          <HealthDot url={server.url} state={reachable[server.url] ?? 'unknown'} />
                        </strong>
                        <small>{new URL(server.url).host}</small>
                      </span>
                    </button>
                    <IconButton
                      label={`Настроить «${serverLabel(server)}»`}
                      onClick={() => setDialog({ server })}
                    >
                      <Settings size={17} />
                    </IconButton>
                  </li>
                ))}
              </ul>
              <button className="text-button connect-add-more" onClick={() => setDialog({})}>
                <Plus size={15} /> Добавить сервер
              </button>
              <form
                className="connect-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void connect();
                }}
              >
                {info?.passwordRequired && (
                  <label>
                    Пароль сервера · {name}
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
                        name: saved?.name ?? '',
                        password: saved?.password ?? '',
                        autoConnect: event.target.checked,
                      });
                      setServers(readServers());
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
              <ConnectionStatus attempt={busy ? null : attempt} />
            </>
          )}
        </section>
      </main>
      <ServerDialog
        open={!!dialog}
        server={dialog?.server}
        onOpenChange={(value) => !value && setDialog(null)}
        onSaved={setServers}
        onConnected={onConnected}
      />
    </div>
  );
}

/** Green when the address answers, red when nothing does, grey until we know. */
export function HealthDot({ url, state }: { url: string; state: Health }) {
  const title =
    state === 'alive'
      ? url === currentServerUrl()
        ? 'Сервер отвечает'
        : 'Адрес отвечает'
      : state === 'dead'
        ? 'Адрес не отвечает'
        : 'Проверяем…';
  return <span className={`health-dot health-${state}`} title={title} role="img" aria-label={title} />;
}
