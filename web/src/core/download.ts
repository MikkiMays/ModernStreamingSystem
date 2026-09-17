/**
 * Откуда взять клиент Cord для Windows.
 *
 * Раньше был один источник: копия, выложенная владельцем этого сервера. Кто поднял Cord по
 * инструкции и ничего не выкладывал, получал страницу «здесь сборки нет», а кнопка «Скачать»
 * на главной просто исчезала — то есть самый частый случай был и самым бесполезным.
 *
 * Поэтому источников три, по очереди:
 *
 *  1. Копия на этом сервере. Быстро, не зависит от GitHub, и обновления клиента ходят туда же.
 *  2. Последний релиз на GitHub. Репозитории публичные, ответ анонимный, версия и размер
 *     настоящие.
 *  3. Просто ссылка на страницу релизов. Работает даже когда API недоступен или исчерпан
 *     лимит запросов: без версии и размера, но с файлом.
 *
 * Кнопка не исчезает никогда — в этом и смысл.
 */
export interface WindowsFile {
  name: string;
  kind: 'installer' | 'portable';
  /** Размер в байтах, или 0, когда источник его не сообщает. */
  size: number;
  url: string;
}
export interface WindowsRelease {
  version: string;
  publishedAt: string;
  installer: WindowsFile | null;
  portable: WindowsFile | null;
  /** Где лежит то, что скачивается: этот сервер или GitHub. */
  origin: 'server' | 'github';
}

const MANIFEST = '/downloads/windows/download.json';
/** Единственное место, где записано, чей это проект. */
export const REPOSITORY = 'MikkiMays/ModernStreamingSystem.Windows';
export const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases/latest`;
/**
 * Прямая ссылка на установщик последнего релиза.
 *
 * Имя без версии живёт в релизе отдельной копией именно ради этого адреса: он не меняется
 * никогда, и по нему можно скачать, не спрашивая GitHub, что сейчас последнее.
 */
export const INSTALLER_URL = `https://github.com/${REPOSITORY}/releases/latest/download/Cord-Setup-x64.exe`;
export const PORTABLE_URL = `https://github.com/${REPOSITORY}/releases/latest/download/Cord-win-x64.zip`;

let asked: Promise<WindowsRelease | null> | undefined;

/** Спрашивается один раз за загрузку страницы и делится между всеми, кто спросил. */
export function windowsRelease(): Promise<WindowsRelease | null> {
  asked ??= load().catch(() => null);
  return asked;
}

async function load(): Promise<WindowsRelease | null> {
  return (await fromServer().catch(() => null)) ?? (await fromGithub().catch(() => null));
}

async function fromServer(): Promise<WindowsRelease | null> {
  const response = await fetch(MANIFEST, { signal: AbortSignal.timeout(6000) });
  if (!response.ok) return null;
  const data = (await response.json()) as {
    version?: unknown;
    tag?: unknown;
    publishedAt?: unknown;
    files?: unknown;
  };
  // A version and a tag that do not agree would build a link to a directory that is not there.
  if (
    typeof data.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(data.version) ||
    data.tag !== `v${data.version}` ||
    !Array.isArray(data.files)
  )
    return null;
  const files = data.files
    .map((entry) => file(entry as Partial<WindowsFile> & { sha256?: unknown }, data.tag as string))
    .filter((entry): entry is WindowsFile => entry !== null);
  const installer = files.find((entry) => entry.kind === 'installer') ?? null;
  if (!installer) return null;
  return {
    version: data.version,
    publishedAt: typeof data.publishedAt === 'string' ? data.publishedAt : '',
    installer,
    portable: files.find((entry) => entry.kind === 'portable') ?? null,
    origin: 'server',
  };
}

/**
 * Последний релиз по данным GitHub.
 *
 * Черновики и предвыпуски `releases/latest` не отдаёт вовсе, поэтому отдельной проверки на
 * них нет. А вот адрес загрузки проверяется: он приходит из ответа и становится ссылкой,
 * по которой человек запустит исполняемый файл, — значит, он обязан вести в наш репозиторий.
 */
async function fromGithub(): Promise<WindowsRelease | null> {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as {
    tag_name?: unknown;
    published_at?: unknown;
    assets?: { name?: unknown; size?: unknown; browser_download_url?: unknown }[];
  };
  if (typeof data.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(data.tag_name)) return null;
  const version = data.tag_name.slice(1);
  const prefix = `https://github.com/${REPOSITORY}/releases/download/${data.tag_name}/`;
  const pick = (match: (name: string) => boolean, kind: WindowsFile['kind']): WindowsFile | null => {
    for (const asset of data.assets ?? []) {
      if (typeof asset.name !== 'string' || !match(asset.name)) continue;
      if (typeof asset.browser_download_url !== 'string' || !asset.browser_download_url.startsWith(prefix))
        continue;
      return {
        name: asset.name,
        kind,
        size: typeof asset.size === 'number' && asset.size > 0 ? asset.size : 0,
        url: asset.browser_download_url,
      };
    }
    return null;
  };
  const installer = pick((name) => name === `Cord-Setup-${version}-x64.exe`, 'installer');
  if (!installer) return null;
  return {
    version,
    publishedAt: typeof data.published_at === 'string' ? data.published_at : '',
    installer,
    portable: pick((name) => name === 'Cord-win-x64.zip', 'portable'),
    origin: 'github',
  };
}

function file(entry: Partial<WindowsFile> & { sha256?: unknown }, tag: string): WindowsFile | null {
  // The name becomes part of a URL, so it may be a file name and nothing more.
  if (
    typeof entry.name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(entry.name) ||
    (entry.kind !== 'installer' && entry.kind !== 'portable') ||
    typeof entry.size !== 'number' ||
    !(entry.size > 0)
  )
    return null;
  return {
    name: entry.name,
    kind: entry.kind,
    size: entry.size,
    url: `/downloads/windows/${tag}/${entry.name}`,
  };
}

export function megabytes(size: number): string {
  return `${(size / 1024 / 1024).toFixed(0)} МБ`;
}

/** Больше ли `candidate`, чем `current`. Обе строки — `x.y.z`. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string) => value.split('.').map((part) => Number(part) || 0);
  const [a, b] = [parse(candidate), parse(current)];
  for (let index = 0; index < 3; index++) {
    if ((a[index] ?? 0) > (b[index] ?? 0)) return true;
    if ((a[index] ?? 0) < (b[index] ?? 0)) return false;
  }
  return false;
}
