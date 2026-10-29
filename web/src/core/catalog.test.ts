import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadServerCatalog, parseServerCatalog, serverName } from './catalog';

/** Каталог так, как его отдаёт ядро: JWS в JSON-сериализации, полезная нагрузка — base64url. */
function jws(payload: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const base64 = btoa(String.fromCharCode(...bytes));
  return {
    payload: base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    signatures: [{ protected: 'e30', signature: 'x' }],
  };
}

const SERVERS = {
  format: 'cord.servers/1',
  seq: 3,
  servers: [
    {
      id: 'ru-msk',
      name: { ru: 'Россия, Москва', en: 'Russia, Moscow' },
      country: 'RU',
      url: 'https://cordcam.ru/',
      order: 20,
      default: true,
    },
    {
      id: 'de-fra',
      name: { ru: 'Германия, Франкфурт', en: 'Germany, Frankfurt' },
      country: 'DE',
      url: 'https://cord.nikg.tech',
      order: 10,
    },
  ],
};

describe('каталог серверов (R136)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('читает серверы по порядку, адрес — origin со слешем, имя — на языке интерфейса', () => {
    const servers = parseServerCatalog(jws(SERVERS));
    expect(servers.map((server) => server.url)).toEqual(['https://cord.nikg.tech/', 'https://cordcam.ru/']);
    expect(serverName(servers[1]!, 'ru-RU')).toBe('Россия, Москва');
    expect(serverName(servers[1]!, 'en-US')).toBe('Russia, Moscow');
    // Языка нет в каталоге — английское имя; нет и его — адрес.
    expect(serverName(servers[0]!, 'de-DE')).toBe('Germany, Frankfurt');
    expect(serverName({ ...servers[0]!, name: {} }, 'de-DE')).toBe('cord.nikg.tech');
  });

  it('чужое и битое пропускает: не https, не тот формат, нечитаемая нагрузка', () => {
    expect(parseServerCatalog(jws({ ...SERVERS, format: 'other/1' }))).toEqual([]);
    expect(parseServerCatalog({ payload: '%%%' })).toEqual([]);
    expect(parseServerCatalog(null)).toEqual([]);
    const mixed = parseServerCatalog(
      jws({
        ...SERVERS,
        servers: [
          ...SERVERS.servers,
          { id: 'http', name: {}, url: 'http://plain.example/', order: 1 },
          { id: 'path', name: {}, url: 'https://evil.example/login?x=1', order: 2 },
          { id: 'dup', name: {}, url: 'https://cordcam.ru', order: 30 },
        ],
      }),
    );
    // Адрес с путём сводится к origin: каталог называет сервер, а не страницу на нём; дубль отброшен.
    expect(mixed.map((server) => server.url)).toEqual([
      'https://evil.example/',
      'https://cord.nikg.tech/',
      'https://cordcam.ru/',
    ]);
  });

  it('спрашивает каталог у своего сервера; 404 — каталога нет, список пуст', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(jws(SERVERS)), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect((await loadServerCatalog()).length).toBe(2);
    expect(fetcher).toHaveBeenCalledWith('/api/v1/catalog', expect.objectContaining({ cache: 'no-store' }));
    fetcher.mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await loadServerCatalog()).toEqual([]);
    fetcher.mockRejectedValueOnce(new TypeError('offline'));
    expect(await loadServerCatalog()).toEqual([]);
  });
});
