/**
 * Откуда взять клиент Cord для Windows.
 *
 * Источник один — копия на этом сервере (`scripts/publish-windows-release.py`): обновления
 * клиента ходят туда же. Cord — продукт, а не исходники, поэтому ни страница скачивания, ни
 * «О программе» не ведут в репозиторий: он приватный, и ссылка на него — это 404.
 *
 * Нет манифеста — нет и кнопки: ответ `null`, и страница честно говорит, что сборки нет.
 */
import { locale, type Translate } from '../i18n';

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
}

const MANIFEST = '/downloads/windows/download.json';

let asked: Promise<WindowsRelease | null> | undefined;

/** Спрашивается один раз за загрузку страницы и делится между всеми, кто спросил. */
export function windowsRelease(): Promise<WindowsRelease | null> {
  asked ??= load().catch(() => null);
  return asked;
}

async function load(): Promise<WindowsRelease | null> {
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

/**
 * Размер файла для глаз: «309 МБ». Единица и число — от `Intl` на языке каталога; без разрядных
 * пробелов, как и было («1235 МБ»), — номер сборки рядом и так длинный.
 */
export function megabytes(t: Translate, size: number): string {
  return new Intl.NumberFormat(locale(t), {
    style: 'unit',
    unit: 'megabyte',
    maximumFractionDigits: 0,
    useGrouping: false,
  }).format(size / 1024 / 1024);
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
