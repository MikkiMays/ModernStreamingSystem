/**
 * The Windows build this server offers, if it offers one.
 *
 * A Cord that somebody installed for themselves has no Windows builds behind it until its
 * operator publishes them, so the answer is allowed to be "none" and the interface has to
 * cope with that rather than hand out a dead link. Asked once per page load and shared.
 */
export interface WindowsFile {
  name: string;
  kind: 'installer' | 'portable';
  size: number;
  sha256: string;
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
    .map((entry) => file(entry as Partial<WindowsFile>, data.tag as string))
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

function file(entry: Partial<WindowsFile>, tag: string): WindowsFile | null {
  // The name becomes part of a URL, so it may be a file name and nothing more.
  if (
    typeof entry.name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(entry.name) ||
    (entry.kind !== 'installer' && entry.kind !== 'portable') ||
    typeof entry.size !== 'number' ||
    !(entry.size > 0) ||
    typeof entry.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    return null;
  return {
    name: entry.name,
    kind: entry.kind,
    size: entry.size,
    sha256: entry.sha256,
    url: `/downloads/windows/${tag}/${entry.name}`,
  };
}

export function megabytes(size: number): string {
  return `${(size / 1024 / 1024).toFixed(0)} МБ`;
}
