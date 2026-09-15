import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const load = () => import('./health');
beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

const ok = () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

/**
 * The dots read this store rather than a plain lookup: with the React compiler on, a module
 * map read during render is invisible and a dot that has turned red keeps showing grey.
 */
it('publishes every answer so the dots can see it', async () => {
  vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
  const { checkHealth, health } = await load();
  const seen: string[] = [];
  health.subscribe(() => seen.push(health.get()['https://watched.example.com/'] ?? '?'));
  await checkHealth('https://watched.example.com/');
  expect(seen).toEqual(['checking', 'dead']);
});

it('asks the server that served this page properly', async () => {
  vi.mocked(fetch).mockResolvedValue(ok());
  const { checkHealth, health } = await load();
  const url = location.origin + '/';
  await expect(checkHealth(url)).resolves.toBe('alive');
  expect(health.get()[url]).toBe('alive');
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/v1/capabilities');
});

/**
 * Another origin will not answer this page — the core refuses a foreign Origin — so the only
 * question a browser can settle is whether anything is there at all. An opaque response is
 * exactly that answer, and it is reported as such rather than as "connected".
 */
it('settles for knowing that a foreign address answered at all', async () => {
  // A real opaque response cannot be constructed by hand; what matters to the probe is only
  // that the promise settled rather than rejected.
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
  const { checkHealth } = await load();
  await expect(checkHealth('https://other.example.com/')).resolves.toBe('alive');
  const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://other.example.com/api/v1/ping');
  expect(init.mode).toBe('no-cors');
});

it('calls an address that will not answer dead, including a refused certificate', async () => {
  vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
  const { checkHealth, health } = await load();
  await expect(checkHealth('https://gone.example.com/')).resolves.toBe('dead');
  expect(health.get()['https://gone.example.com/']).toBe('dead');
});

it('reuses a settled answer instead of letting the light flicker', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }));
  const { checkHealth, health } = await load();
  await checkHealth('https://kept.example.com/');
  await checkHealth('https://kept.example.com/');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(health.get()['https://kept.example.com/']).toBe('alive');
  await checkHealth('https://kept.example.com/', true);
  expect(fetch, 'saving an entry asks again on purpose').toHaveBeenCalledTimes(2);
});

it('asks once while an answer is still coming', async () => {
  let settle!: (value: Response) => void;
  vi.mocked(fetch).mockReturnValue(
    new Promise<Response>((done) => {
      settle = done;
    }),
  );
  const { checkHealth, health } = await load();
  const first = checkHealth('https://slow.example.com/');
  const second = checkHealth('https://slow.example.com/');
  expect(health.get()['https://slow.example.com/']).toBe('checking');
  expect(fetch).toHaveBeenCalledTimes(1);
  settle(new Response(null, { status: 200 }));
  await expect(Promise.all([first, second])).resolves.toEqual(['alive', 'alive']);
});
