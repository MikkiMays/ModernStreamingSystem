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
const REPO = 'MikkiMays/ModernStreamingSystem.Windows';
const download = (tag: string, name: string) => `https://github.com/${REPO}/releases/download/${tag}/${name}`;
const githubRelease = {
  tag_name: 'v0.7.0',
  published_at: '2026-09-17T10:00:00Z',
  assets: [
    {
      name: 'Cord-Setup-0.7.0-x64.exe',
      size: 324227543,
      browser_download_url: download('v0.7.0', 'Cord-Setup-0.7.0-x64.exe'),
    },
    {
      name: 'Cord-win-x64.zip',
      size: 94160968,
      browser_download_url: download('v0.7.0', 'Cord-win-x64.zip'),
    },
  ],
};
const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const missing = () => new Response('', { status: 404 });
// The module remembers its answer for the page load, so each test needs its own copy.
const load = () => import('./download');
/** First call is this server's own copy, second is GitHub. */
const answers = (server: Response, github: Response) => {
  const calls = [server, github];
  vi.mocked(fetch).mockImplementation(() => Promise.resolve(calls.shift() ?? missing()));
};

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
  expect(release?.origin).toBe('server');
  expect(release?.installer?.url).toBe('/downloads/windows/v0.6.0/Cord-Setup-0.6.0-x64.exe');
  expect(release?.portable?.url).toBe('/downloads/windows/v0.6.0/Cord-win-x64.zip');
  expect(megabytes(release!.installer!.size)).toBe('309 МБ');
  // Asked once per page load: the link in the header and the page itself share one answer.
  expect(fetch).toHaveBeenCalledTimes(1);
  await windowsRelease();
  expect(fetch).toHaveBeenCalledTimes(1);
});

/**
 * Самый частый случай: кто-то поднял Cord по инструкции и ничего у себя не выкладывал.
 * Раньше это была страница «здесь сборки нет», теперь — последний релиз проекта.
 */
it('берёт релиз с GitHub, когда этот сервер ничего не выкладывал', async () => {
  answers(missing(), answer(githubRelease));
  const { windowsRelease } = await load();
  const release = await windowsRelease();
  expect(release?.version).toBe('0.7.0');
  expect(release?.origin).toBe('github');
  expect(release?.installer?.url).toBe(download('v0.7.0', 'Cord-Setup-0.7.0-x64.exe'));
  expect(release?.portable?.url).toBe(download('v0.7.0', 'Cord-win-x64.zip'));
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
    { ...manifest, files: [{ ...manifest.files[0], size: 0 }] },
    { ...manifest, files: [manifest.files[1]] },
    { ...manifest, files: 'not a list' },
  ]) {
    vi.resetModules();
    answers(answer(broken), missing());
    const { windowsRelease } = await load();
    await expect(windowsRelease(), JSON.stringify(broken).slice(0, 80)).resolves.toBeNull();
  }
});

/**
 * Адрес загрузки приходит из ответа и становится ссылкой, по которой человек запустит
 * исполняемый файл. Значит, он обязан вести в наш репозиторий и никуда больше.
 */
it('refuses a GitHub answer that points the button off the repository', async () => {
  for (const broken of [
    { ...githubRelease, tag_name: 'latest' },
    {
      ...githubRelease,
      assets: [{ ...githubRelease.assets[0], browser_download_url: 'https://evil.test/Cord-Setup.exe' }],
    },
    {
      ...githubRelease,
      assets: [{ ...githubRelease.assets[0], name: 'Cord-Setup-9.9.9-x64.exe' }],
    },
    { ...githubRelease, assets: [githubRelease.assets[1]] },
  ]) {
    vi.resetModules();
    answers(missing(), answer(broken));
    const { windowsRelease } = await load();
    await expect(windowsRelease(), JSON.stringify(broken).slice(0, 80)).resolves.toBeNull();
  }
});

it('сравнивает версии по числам, а не по строкам', async () => {
  const { isNewer } = await load();
  expect(isNewer('0.10.0', '0.9.9')).toBe(true);
  expect(isNewer('0.7.0', '0.7.0')).toBe(false);
  expect(isNewer('0.6.3', '0.7.0')).toBe(false);
  expect(isNewer('1.0.0', '0.99.99')).toBe(true);
});
