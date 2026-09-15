import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const manifest = {
  version: '0.6.0',
  tag: 'v0.6.0',
  publishedAt: '2026-09-15T13:19:55Z',
  files: [
    { name: 'Cord-Setup-0.6.0-x64.exe', kind: 'installer', size: 324227543, sha256: 'a'.repeat(64) },
    { name: 'Cord-win-x64.zip', kind: 'portable', size: 94160968, sha256: 'b'.repeat(64) },
  ],
};
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// The module remembers its answer for the page load, so each test needs its own copy.
const load = () => import('./download');

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

it('turns the published manifest into the two links the page draws', async () => {
  vi.mocked(fetch).mockResolvedValue(answer(manifest));
  const { windowsRelease, megabytes } = await load();
  const release = await windowsRelease();
  expect(release?.version).toBe('0.6.0');
  expect(release?.installer?.url).toBe('/downloads/windows/v0.6.0/Cord-Setup-0.6.0-x64.exe');
  expect(release?.portable?.url).toBe('/downloads/windows/v0.6.0/Cord-win-x64.zip');
  expect(megabytes(release!.installer!.size)).toBe('309 МБ');
  // Asked once per page load: the link in the header and the page itself share one answer.
  expect(fetch).toHaveBeenCalledTimes(1);
  await windowsRelease();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('offers nothing when this server publishes nothing', async () => {
  vi.mocked(fetch).mockResolvedValue(new Response('', { status: 404 }));
  const { windowsRelease } = await load();
  await expect(windowsRelease()).resolves.toBeNull();
});

it('survives a server that answers the address with something else entirely', async () => {
  vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
  const { windowsRelease } = await load();
  await expect(windowsRelease()).resolves.toBeNull();
});

/** The file name becomes part of a URL, so it may be a file name and nothing else. */
it('refuses a manifest that could point the button somewhere else', async () => {
  for (const broken of [
    { ...manifest, tag: 'v0.5.0' },
    { ...manifest, version: 'latest' },
    { ...manifest, files: [{ ...manifest.files[0], name: '../../etc/passwd' }] },
    { ...manifest, files: [{ ...manifest.files[0], name: 'https://evil.test/x.exe' }] },
    { ...manifest, files: [{ ...manifest.files[0], sha256: 'short' }] },
    { ...manifest, files: [{ ...manifest.files[0], size: 0 }] },
    { ...manifest, files: [manifest.files[1]] },
    { ...manifest, files: 'not a list' },
  ]) {
    vi.resetModules();
    vi.mocked(fetch).mockResolvedValue(answer(broken));
    const { windowsRelease } = await load();
    await expect(windowsRelease(), JSON.stringify(broken).slice(0, 80)).resolves.toBeNull();
  }
});
