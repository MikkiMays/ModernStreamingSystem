import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Server, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Capabilities } from '../api/types';
import { DownloadLink, Logo } from './primitives';
import { Button, Field, Input } from './kit';
import './shell.css';
import { currentServerUrl, rememberServer, serverLabel, thisServer } from '../core/servers';
import { describeFailure, openConnection, serverInfo, type Attempt } from '../core/session';
import { ensureNotificationAudio } from '../core/sounds';
import { HelpButton } from './support/HelpButton';

/**
 * The first screen, and until the handshake succeeds the only one. Nothing about meetings is
 * shown before the server has answered: favourites belong to a server, and a client has no
 * business displaying one server's rooms while connected to another.
 *
 * There is exactly one server here — Cord is one address (R195): the core refuses a foreign
 * `Origin`, and the meeting itself lives on whichever media node the system measures as nearest,
 * which is not a choice a person makes. Connecting is always automatic (R135, R195): the switch
 * and «Другой сервер…» are gone in the browser and in the Windows client alike.
 */
/** Паузы между повторами, когда сервер не ответил: дальше — раз в полминуты, пока экран открыт. */
const RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

export function Connect({ onConnected }: { onConnected: () => void }) {
  const { t } = useTranslation();
  const here = currentServerUrl();
  const saved = thisServer();
  const [password, setPassword] = useState(saved.password);
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
      rememberServer({ password: secret });
      onConnected();
    }
    return result.ok;
  };

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    // Подключение всегда само (R135, R195): сервер один, выбирать и «не подключаться» нечего.
    const automatic = () => true;
    /*
      Сервер не ответил — сбой сети, замирание машины сервера, — а подключение само: пробуем ещё,
      пока экран открыт, с паузой всё длиннее и сразу, как вернулась сеть. Раньше «Не подключено»
      оставалось, пока человек сам не нажмёт «Подключиться» (стенд, 01.11.2026: 20 минут после
      46-секундного замирания хоста).
    */
    const retry = () => {
      if (!active || !automatic()) return;
      clearTimeout(timer);
      timer = setTimeout(probe, RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]);
    };
    const probe = () => {
      void serverInfo()
        .then(async (capabilities) => {
          if (!active) return;
          setInfo(capabilities);
          // Connecting to an open server asks nothing, so waiting for a click on a screen with
          // no question on it would be a step for its own sake. A closed one waits unless this
          // device kept the password.
          const remembered = thisServer();
          const ready = !capabilities.passwordRequired || !!remembered.password;
          if (automatic() && ready && !started.current) {
            started.current = true;
            const ok = await connect(remembered.password);
            // Открытому серверу отказать по паролю нечем: неудача — это сеть, её и повторяем. Закрытый
            // мог отказать паролем — тогда ждём человека, а не долбим сервер неверным.
            if (!ok && active && !capabilities.passwordRequired) {
              started.current = false;
              retry();
            }
          }
        })
        .catch((error) => {
          if (!active) return;
          setAttempt({ ok: false, detail: describeFailure(error) });
          retry();
        });
    };
    const online = () => {
      if (!active || started.current) return;
      failures = 0;
      clearTimeout(timer);
      probe();
    };
    window.addEventListener('online', online);
    probe();
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener('online', online);
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
          <span className="shell-header__note">{t(($) => $.connect.note)}</span>
          {/* Застрял у двери — помощь здесь же (T36): форма открыта и до пароля сервера. */}
          <HelpButton faq="network" />
          <DownloadLink className="shell-download" />
        </div>
      </header>
      <main className="shell-main">
        <section className="shell-card connect-card" aria-labelledby="connect-title">
          <span className="connect-card__badge" aria-hidden="true">
            <Server size={24} />
          </span>
          <div className="connect-card__heading">
            <h1 id="connect-title">{waiting ? t(($) => $.connect.searching) : name}</h1>
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
              <Field label={t(($) => $.connect.password)}>
                <Input
                  type="password"
                  value={password}
                  maxLength={200}
                  autoComplete="current-password"
                  autoFocus
                  placeholder={t(($) => $.connect.passwordPlaceholder)}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Field>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              full
              loading={busy}
              disabled={waiting}
              icon={busy ? undefined : <ArrowRight size={24} />}
            >
              {busy ? t(($) => $.connect.connecting) : t(($) => $.connect.connect)}
            </Button>
          </form>
          <div className="connect-card__status">
            <ConnectionStatus attempt={busy ? null : attempt} />
          </div>
        </section>
      </main>
    </div>
  );
}

/** Small, green when it worked; red with the reason folded away when it did not. */
export function ConnectionStatus({ attempt }: { attempt: Attempt | null }) {
  const { t } = useTranslation();
  if (!attempt) return <span className="connection-status" />;
  if (attempt.ok)
    return (
      <span className="connection-status connected" role="status">
        <Check size={12} /> {t(($) => $.connect.connected)}
      </span>
    );
  return (
    <details className="connection-status failed">
      <summary role="status">
        <TriangleAlert size={12} /> {t(($) => $.connect.notConnected)}
      </summary>
      <small>{attempt.detail}</small>
    </details>
  );
}
