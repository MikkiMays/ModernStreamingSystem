import { useEffect, useState } from 'react';
import { Check, Plug, Trash2, TriangleAlert } from 'lucide-react';
import { Modal } from './primitives';
import {
  currentServerUrl,
  normalizeServerUrl,
  removeServer,
  saveServer,
  type SavedServer,
} from '../core/servers';
import { checkConnection, openConnection, type Attempt } from '../core/session';
import { ensureNotificationAudio } from '../core/sounds';
import { notifyDesktop } from '../core/desktop';

/**
 * Adding a server and connecting to one are the same form filled in from two places, so they
 * are the same dialog. What differs is the button: from the connect screen it says
 * «Подключиться» and actually opens the server; from the settings it says «Добавить» and only
 * writes the entry down. Checking is always optional — an address can be saved for later
 * without the server being up right now.
 */
export type ServerDialogIntent = 'connect' | 'save';

const blank = (): SavedServer => ({ url: '', name: '', password: '', autoConnect: true });

export function ServerDialog({
  open,
  onOpenChange,
  intent,
  server,
  onConnected,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  intent: ServerDialogIntent;
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

  const here = (() => {
    try {
      return normalizeServerUrl(draft.url) === currentServerUrl();
    } catch {
      return false;
    }
  })();
  const desktop = !!window.chrome?.webview;
  const own = server?.url === currentServerUrl();

  const store = () => {
    const saved = saveServer({ ...draft, url: normalizeServerUrl(draft.url) });
    onSaved?.(saved);
    return saved;
  };
  const shake = async (keep: boolean) => {
    setBusy(true);
    setError('');
    try {
      ensureNotificationAudio();
      const result = await (keep ? openConnection(draft.password) : checkConnection(draft.password));
      setAttempt(result);
      return result.ok;
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    try {
      setError('');
      normalizeServerUrl(draft.url);
    } catch (problem) {
      setError((problem as Error).message);
      return;
    }
    if (intent === 'save') {
      store();
      onOpenChange(false);
      return;
    }
    store();
    // Only the server that served this page will answer this browser: the core refuses a
    // foreign Origin. Reaching another one means going there, or — inside the application —
    // letting the native shell do it, because it has no such limit.
    if (!here) {
      if (desktop) notifyDesktop('servers.open');
      else location.assign(normalizeServerUrl(draft.url));
      return;
    }
    if (await shake(true)) {
      onConnected?.();
      onOpenChange(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={intent === 'connect' ? 'Подключение к серверу' : editing ? 'Сервер' : 'Новый сервер'}
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
            onChange={(event) => setDraft({ ...draft, url: event.target.value, password: draft.password })}
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
            {busy ? 'Проверяем…' : intent === 'connect' ? 'Подключиться' : editing ? 'Сохранить' : 'Добавить'}
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
          <ConnectionStatus attempt={attempt} />
          <button
            className="text-button server-check"
            type="button"
            disabled={busy || !here}
            title={
              here
                ? 'Соединиться и сразу отпустить'
                : 'Проверить можно только тот сервер, который открыт сейчас'
            }
            onClick={() => void shake(false)}
          >
            <Plug size={14} /> Проверить подключение
          </button>
        </div>
      </form>
    </Modal>
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
