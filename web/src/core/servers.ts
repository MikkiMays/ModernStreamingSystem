/**
 * The servers this device knows about.
 *
 * A browser can only talk to the origin that served the page — the core refuses a foreign
 * `Origin` header — so this list is a set of bookmarks, not a set of live connections.
 * Choosing another entry navigates there; that server's own page then greets you. The
 * desktop application keeps its own list natively and can reach any of them directly.
 *
 * Because storage is per origin, the list is what *this* server's page remembers. Saying so
 * in the interface is better than pretending the browser has one global list.
 */
const KEY = 'cord:servers:v1';
export const MAX_SERVERS = 20;

export interface SavedServer {
  /** A normalised origin with a trailing slash, the same shape the desktop client stores. */
  url: string;
  name: string;
  /** Kept on this device so a server can be reopened without retyping. May be empty. */
  password: string;
  autoConnect: boolean;
}

/** Mirrors `ServerEndpoint.Parse` in the Windows client so one address cannot become two entries. */
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

export function currentServerUrl(): string {
  return location.origin + '/';
}

function sanitize(entry: Partial<SavedServer> | undefined): SavedServer | null {
  if (!entry || typeof entry.url !== 'string') return null;
  let url: string;
  try {
    url = normalizeServerUrl(entry.url);
  } catch {
    return null;
  }
  return {
    url,
    name: typeof entry.name === 'string' ? entry.name.trim().slice(0, 60) : '',
    password: typeof entry.password === 'string' ? entry.password.slice(0, 200) : '',
    autoConnect: entry.autoConnect !== false,
  };
}

export function readServers(): SavedServer[] {
  let stored: unknown = [];
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    /* A corrupt list is replaced by the one server we are certainly on. */
  }
  const servers: SavedServer[] = [];
  const seen = new Set<string>();
  if (Array.isArray(stored))
    for (const raw of stored) {
      const entry = sanitize(raw as Partial<SavedServer>);
      if (entry && !seen.has(entry.url) && servers.length < MAX_SERVERS) {
        seen.add(entry.url);
        servers.push(entry);
      }
    }
  // The server actually serving this page is always reachable, whether or not it was saved.
  if (!seen.has(currentServerUrl()))
    servers.unshift({ url: currentServerUrl(), name: '', password: '', autoConnect: true });
  return servers;
}

function write(servers: SavedServer[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(servers.slice(0, MAX_SERVERS)));
  } catch {
    /* Private browsing keeps the list for this visit only. */
  }
  window.dispatchEvent(new Event('cord:servers'));
}

/** Adds a server, or updates the one already saved under that origin without reordering. */
export function saveServer(entry: SavedServer): SavedServer[] {
  const normalized = sanitize(entry);
  if (!normalized) throw new Error('Укажите адрес сервера');
  const servers = readServers();
  const existing = servers.findIndex((server) => server.url === normalized.url);
  if (existing >= 0) servers[existing] = normalized;
  else servers.unshift(normalized);
  write(servers);
  return servers;
}

export function removeServer(url: string): SavedServer[] {
  const servers = readServers().filter((server) => server.url !== url);
  write(servers);
  return servers;
}

export function findServer(url: string): SavedServer | undefined {
  return readServers().find((server) => server.url === url);
}

/** What to call a server in a list: the user's own label, or its bare host. */
export function serverLabel(server: Pick<SavedServer, 'url' | 'name'>): string {
  if (server.name.trim()) return server.name.trim();
  try {
    return new URL(server.url).host;
  } catch {
    return server.url;
  }
}
