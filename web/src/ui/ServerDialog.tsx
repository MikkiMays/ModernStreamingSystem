import { useEffect, useState } from 'react';
import { ArrowRight, Check, Trash2, TriangleAlert } from 'lucide-react';
import { Modal } from './primitives';
import {
  currentServerUrl,
  normalizeServerUrl,
  removeServer,
  saveServer,
  type SavedServer,
} from '../core/servers';
import { openConnection, type Attempt } from '../core/session';
import { checkHealth } from '../core/health';
import { ensureNotificationAudio } from '../core/sounds';
import { notifyDesktop } from '../core/desktop';

/**
 * Adding a server and connecting to one are the same act, so they are one button. There is no
 * separate check: connecting *is* the check, and a dialog that closed on a check would have
 * said "fine" about something it had not done.
 *
 * The dialog closes on a connection and on nothing else. A refusal keeps the reason on screen
 * where it can be acted on — and offers to write the address down anyway, because a server
 * still being set up is worth saving before it answers.
 */
const blank = (): SavedServer => ({ url: '', name: '', password: '', autoConnect: true });

export function ServerDialog({
  open,
  onOpenChange,
  server,
  onConnected,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The entry being edited, or nothing when a new server is being added. */
  server?: SavedServer;
  onConnected?: () => void;
  onSaved?: (servers: SavedServer[]) => void;
}) {
  const editing = !!server;
  const [draft, setDraft] = useState<SavedServer>(server ?? blank);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setDraft(server ? { ...server } : blank());
      setAttempt(null);
      setError('');
    }
  }, [open, server]);

  const normalized = (() => {
    try {
      return normalizeServerUrl(draft.url);
    } catch {
      return null;
    }
  })();
  const here = normalized === currentServerUrl();
  const desktop = !!window.chrome?.webview;
  const own = server?.url === currentServerUrl();

  const store = () => {
    const list = saveServer({ ...draft, url: normalizeServerUrl(draft.url) });
    onSaved?.(list);
    // Not a forced refresh: this address was probed a moment ago, and asking again would put
    // the light back to grey right after it said something.
    void checkHealth(normalizeServerUrl(draft.url));
    return list;
  };
  const submit = async () => {
    setError('');
    if (!normalized) {
      try {
        normalizeServerUrl(draft.url);
      } catch (problem) {
        setError((problem as Error).message);
      }
      return;
    }
    setBusy(true);
    ensureNotificationAudio();
    try {
      // Only the server that served this page will answer it, so reaching another one means
      // going there. Never blindly: landing on a browser error page would lose Cord as well
      // as the address, so the address has to answer something first.
      if (!here) {
        if ((await checkHealth(normalized)) !== 'alive') {
          setAttempt({
            ok: false,
            detail: 'По этому адресу ничего не ответило. Проверьте адрес, сертификат и соединение.',
          });
          return;
        }
        store();
        if (desktop) notifyDesktop('servers.open');
        else location.assign(normalized);
        onOpenChange(false);
        return;
      }
      const result = await openConnection(draft.password);
      setAttempt(result);
      if (!result.ok) return;
      store();
      onConnected?.();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'Сервер' : 'Новый сервер'}
      description="Адрес и пароль хранятся на этом устройстве."
      closeLabel="Закрыть окно"
    >
      <form
        className="server-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label>
          Название сервера
          <input
            value={draft.name}
            maxLength={60}
            autoComplete="off"
            placeholder="Как называть его в списке"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label>
          Адрес сервера
          <input
            value={draft.url}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://meet.example.com"
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
          />
        </label>
        <label>
          Пароль
          <input
            type="password"
            value={draft.password}
            maxLength={200}
            autoComplete="off"
            placeholder="Если сервер закрыт паролем"
            onChange={(event) => setDraft({ ...draft, password: event.target.value })}
          />
        </label>
        <label className="check-setting">
          <input
            type="checkbox"
            checked={draft.autoConnect}
            onChange={(event) => setDraft({ ...draft, autoConnect: event.target.checked })}
          />
          <span>
            Подключаться автоматически
            <small>При открытии Cord сразу соединяться с этим сервером.</small>
          </span>
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="server-form-actions">
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? (
              <>
                <LoaderDots /> Подключаемся…
              </>
            ) : (
              <>
                Подключиться <ArrowRight size={17} />
              </>
            )}
          </button>
          <button className="button ghost" type="button" onClick={() => onOpenChange(false)}>
            Закрыть
          </button>
          {editing && !own && (
            <button
              className="button ghost server-forget"
              type="button"
              onClick={() => {
                onSaved?.(removeServer(server.url));
                onOpenChange(false);
              }}
            >
              <Trash2 size={16} /> Удалить
            </button>
          )}
        </div>
        <div className="server-status-row">
          <ConnectionStatus attempt={busy ? null : attempt} />
          {attempt && !attempt.ok && (
            <button
              className="text-button"
              type="button"
              onClick={() => {
                store();
                onOpenChange(false);
              }}
            >
              Всё равно сохранить
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function LoaderDots() {
  return <span className="loader-dots" aria-hidden="true" />;
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
