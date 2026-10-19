import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Server, TriangleAlert } from 'lucide-react';
import type { Capabilities } from '../api/types';
import { DownloadLink, Logo } from './primitives';
import { Button, Field, Input, Switch } from './kit';
import './shell.css';
import { currentServerUrl, rememberServer, serverLabel, thisServer } from '../core/servers';
import { describeFailure, openConnection, serverInfo, type Attempt } from '../core/session';
import { ensureNotificationAudio } from '../core/sounds';
import { notifyDesktop } from '../core/desktop';

/**
 * The first screen, and until the handshake succeeds the only one. Nothing about meetings is
 * shown before the server has answered: favourites belong to a server, and a client has no
 * business displaying one server's rooms while connected to another.
 *
 * There is exactly one server here, because in a browser there can be only one: the core
 * refuses a foreign `Origin`, so this page can talk to the server that served it and to
 * nothing else. A list of others would be bookmarks pretending to be connections — unable to
 * be checked or connected to, and switching would mean leaving the application. That list
 * belongs to the Windows client, which has none of those limits; from inside it this screen
 * can ask the shell to open it.
 */
export function Connect({ onConnected }: { onConnected: () => void }) {
  const desktop = !!window.chrome?.webview;
  const here = currentServerUrl();
  const saved = thisServer();
  const [password, setPassword] = useState(saved.password);
  const [autoConnect, setAutoConnect] = useState(saved.autoConnect);
  const [info, setInfo] = useState<Capabilities | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const connect = async (secret = password) => {
    setBusy(true);
    ensureNotificationAudio();
    const result = await openConnection(secret);
    setAttempt(result);
    setBusy(false);
    if (result.ok) {
      rememberServer({ password: secret, autoConnect });
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
        const remembered = thisServer();
        const ready = !capabilities.passwordRequired || !!remembered.password;
        if (remembered.autoConnect && ready && !started.current) {
          started.current = true;
          void connect(remembered.password);
        }
      })
      .catch((error) => {
        if (active) setAttempt({ ok: false, detail: describeFailure(error) });
      });
    return () => {
      active = false;
    };
    // Deliberately empty: the handshake belongs to this mount. Listing the password here would
    // re-run it on every keystroke.
  }, []);

  const name = saved.name.trim() || info?.name || serverLabel({ url: here, name: '' });
  const waiting = !info && !attempt;
  return (
    <div className="shell-page">
      <header className="shell-header">
        <Logo />
        <div className="shell-header__end">
          <span className="shell-header__note">Подключение к серверу</span>
          <DownloadLink className="shell-download" />
        </div>
      </header>
      <main className="shell-main">
        <section className="shell-card connect-card" aria-labelledby="connect-title">
          <span className="connect-card__badge" aria-hidden="true">
            <Server size={22} />
          </span>
          <div className="connect-card__heading">
            <h1 id="connect-title">{waiting ? 'Ищем сервер…' : name}</h1>
            <p>{new URL(here).host}</p>
          </div>
          <form
            className="connect-card__form"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            {info?.passwordRequired && (
              <Field label="Пароль сервера">
                <Input
                  type="password"
                  value={password}
                  maxLength={200}
                  autoComplete="current-password"
                  autoFocus
                  placeholder="Спросите у того, кто дал адрес"
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            )}
            <Switch
              label="Подключаться автоматически при запуске"
              checked={autoConnect}
              onCheckedChange={(checked) => {
                setAutoConnect(checked);
                rememberServer({ autoConnect: checked });
              }}
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              full
              loading={busy}
              disabled={waiting}
              icon={busy ? undefined : <ArrowRight size={18} />}
            >
              {busy ? 'Подключаемся…' : 'Подключиться'}
            </Button>
          </form>
          <div className="connect-card__status">
            <ConnectionStatus attempt={busy ? null : attempt} />
            {desktop && (
              <Button variant="quiet" size="sm" onClick={() => notifyDesktop('servers.open')}>
                Другой сервер…
              </Button>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

/** Small, green when it worked; red with the reason folded away when it did not. */
export function ConnectionStatus({ attempt }: { attempt: Attempt | null }) {
  if (!attempt) return <span className="connection-status" />;
  if (attempt.ok)
    return (
      <span className="connection-status connected" role="status">
        <Check size={14} /> Подключено!
      </span>
    );
  return (
    <details className="connection-status failed">
      <summary role="status">
        <TriangleAlert size={14} /> Не подключено
      </summary>
      <small>{attempt.detail}</small>
    </details>
  );
}
