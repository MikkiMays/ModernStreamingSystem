/**
 * Каталог серверов Cord этой установки — для «Сменить сервер» в браузере (R136).
 *
 * Ядро отдаёт файл владельца как есть (`GET /api/v1/catalog`, формат `cord.servers/1`, ADR 0001 §8):
 * JWS в JSON-сериализации, полезная нагрузка — base64url. Подпись здесь не проверяется: её сверяет
 * приложение для Windows, которому каталог решает, куда подключаться. Странице её сервер и так
 * отдаёт весь код, а смена сервера в браузере — просто переход на другой сайт Cord: страница этого
 * сайта уже не наша, и вход там свой.
 *
 * Каталога нет (404), он не читается или сеть упала — список пуст, и выбирать не из чего.
 */
export interface CatalogServer {
  id: string;
  /** Origin со слешем — так же, как `currentServerUrl()`. */
  url: string;
  /** Имена по языкам: `{ ru, en }`. */
  name: Record<string, string>;
}

const FORMAT = 'cord.servers/1';

function decode(payload: string): unknown {
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
}

function origin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    // Только https; http — лишь у своей машины, где Cord поднимают для разработки.
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || local ? `${url.origin}/` : null;
  } catch {
    return null;
  }
}

/** Ответ ядра без доверия: каждое поле по схеме, непонятное отбрасывается, порядок — `order`. */
export function parseServerCatalog(body: unknown): CatalogServer[] {
  let data: unknown;
  try {
    const payload = (body as { payload?: unknown } | null)?.payload;
    data = typeof payload === 'string' ? decode(payload) : null;
  } catch {
    return [];
  }
  const catalog = data as { format?: unknown; servers?: unknown } | null;
  if (!catalog || catalog.format !== FORMAT || !Array.isArray(catalog.servers)) return [];
  const seen = new Set<string>();
  return (catalog.servers as Record<string, unknown>[])
    .map((entry, index) => ({ entry, index, url: origin(entry?.url) }))
    .filter((item): item is typeof item & { url: string } => !!item.url)
    .sort(
      (a, b) =>
        (typeof a.entry.order === 'number' ? a.entry.order : Infinity) -
          (typeof b.entry.order === 'number' ? b.entry.order : Infinity) || a.index - b.index,
    )
    .filter(({ url }) => !seen.has(url) && !!seen.add(url))
    .map(({ entry, url }) => {
      const names: Record<string, string> = {};
      if (entry.name && typeof entry.name === 'object')
        for (const [language, text] of Object.entries(entry.name as Record<string, unknown>))
          if (typeof text === 'string' && text.trim()) names[language] = text.trim().slice(0, 60);
      return { id: typeof entry.id === 'string' ? entry.id : url, url, name: names };
    });
}

/** Имя на языке интерфейса (`ru-RU` → `ru`), иначе английское, иначе адрес сервера. */
export function serverName(server: CatalogServer, locale: string): string {
  const language = locale.split('-')[0] ?? '';
  return server.name[locale] ?? server.name[language] ?? server.name.en ?? new URL(server.url).host;
}

export async function loadServerCatalog(): Promise<CatalogServer[]> {
  try {
    const response = await fetch('/api/v1/catalog', { cache: 'no-store', credentials: 'omit' });
    return response.ok ? parseServerCatalog(await response.json()) : [];
  } catch {
    return [];
  }
}
