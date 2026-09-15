/**
 * What this device remembers about the server it is on.
 *
 * A browser has exactly one: the core refuses a foreign `Origin`, so the page can only ever
 * talk to the server that served it. A list of others would be a list of bookmarks pretending
 * to be connections — it could not check them, could not connect to them, and switching would
 * mean leaving the application. The Windows client keeps the real list, natively, because it
 * has none of those limits.
 *
 * Storage is per origin, so this entry is already per server: the password and the automatic
 * connection for one server can never be read as another's.
 */
const KEY = 'cord:servers:v1';

export interface ServerPreference {
  /** A normalised origin with a trailing slash, the same shape the Windows client stores. */
  url: string;
  name: string;
  /** Kept on this device so the server can be reopened without retyping. May be empty. */
  password: string;
  autoConnect: boolean;
}

export function currentServerUrl(): string {
  return location.origin + '/';
}

/** Mirrors `ServerEndpoint.Parse` in the Windows client so one address cannot become two. */
export function normalizeServerUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Укажите адрес сервера');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error('Адрес не похож на ссылку. Пример: https://meet.example.com');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password) throw new Error('Уберите имя и пароль из адреса');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Адрес должен начинаться с https://. HTTP допустим только для localhost');
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash)
    throw new Error('Укажите только адрес сервера, без пути после имени');
  return url.origin + '/';
}

/** What is remembered about this server, with sane answers when nothing has been saved yet. */
export function thisServer(): ServerPreference {
  let stored: Partial<ServerPreference> | undefined;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    // Written as a list by earlier versions, which kept bookmarks to other servers here.
    const entries = Array.isArray(saved) ? saved : saved ? [saved] : [];
    stored = (entries as Partial<ServerPreference>[]).find((entry) => entry?.url === currentServerUrl());
  } catch {
    /* Anything unreadable means nothing has been remembered. */
  }
  return {
    url: currentServerUrl(),
    name: typeof stored?.name === 'string' ? stored.name.trim().slice(0, 60) : '',
    password: typeof stored?.password === 'string' ? stored.password.slice(0, 200) : '',
    autoConnect: stored?.autoConnect !== false,
  };
}

export function rememberServer(patch: Partial<Omit<ServerPreference, 'url'>>): ServerPreference {
  const next = { ...thisServer(), ...patch, url: currentServerUrl() };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* Private browsing keeps it for this visit only. */
  }
  return next;
}

/** What to call this server: the name given to it here, or its bare host. */
export function serverLabel(server: Pick<ServerPreference, 'url' | 'name'>): string {
  if (server.name.trim()) return server.name.trim();
  try {
    return new URL(server.url).host;
  } catch {
    return server.url;
  }
}
