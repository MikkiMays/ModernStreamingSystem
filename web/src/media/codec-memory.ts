import type { FailReason, GpuHint, PolicyLevel, PolicySource } from './codec-policy';

/**
 * Память машины о кодеках (R189, И2): что сторож кодировщика узнал о перегрузке, применяется не
 * посреди потока, а при следующем естественном старте — включении камеры, входе, полном
 * переподключении. Переопубликация ради кодека на ходу — это исчезнувшая плитка у каждого зрителя и
 * чёрный кадр до ключевого; здесь то же знание действует там, где камера и так стартует, и никто
 * этого не видит.
 *
 * Запись: ступень (`av1:hw`), почему отвергнута (`cpu`, `encode-time`, `software`), уровень, при котором
 * это случилось, и когда. Ступень, не потянувшая 720p30, не потянет и 1080p30 — запись действует на
 * этот уровень и всё, что не легче. Срок — {@link MEMORY_DAYS}: машина меняется (драйвер, закрытая
 * тяжёлая программа), и навсегда отвергать ступень нельзя. Область — браузер и видеокарта, как у
 * кэша ответов кодировщика (`codec-probe.ts`).
 */
export interface CodecMemory {
  failed(source: PolicySource, scope: string, level: PolicyLevel): Map<string, FailReason>;
  remember(source: PolicySource, scope: string, level: PolicyLevel, rung: string, reason: FailReason): void;
}

export const MEMORY_KEY = 'cord:codec-memory:v1';
export const MEMORY_DAYS = 7;
const MEMORY_LIMIT = 40;

interface Entry {
  scope: string;
  source: PolicySource;
  rung: string;
  reason: FailReason;
  height: number;
  fps: number;
  at: number;
}

/** Область памяти: браузер и видеокарта — как у кэша ответов кодировщика. */
export function memoryScope(gpu: GpuHint | null | undefined): string {
  const agent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return `${agent}|${(gpu as { identity?: string } | null | undefined)?.identity ?? ''}`;
}

/** Без памяти — в тестах и там, где хранилища нет. */
export const NO_MEMORY: CodecMemory = {
  failed: () => new Map(),
  remember: () => {},
};

export class StoredCodecMemory implements CodecMemory {
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  failed(source: PolicySource, scope: string, level: PolicyLevel): Map<string, FailReason> {
    const result = new Map<string, FailReason>();
    for (const entry of this.read())
      if (
        entry.scope === scope &&
        entry.source === source &&
        entry.height <= level.height &&
        entry.fps <= level.fps
      )
        result.set(entry.rung, entry.reason);
    return result;
  }

  remember(source: PolicySource, scope: string, level: PolicyLevel, rung: string, reason: FailReason): void {
    const kept = this.read().filter(
      (entry) => !(entry.scope === scope && entry.source === source && entry.rung === rung),
    );
    kept.push({ scope, source, rung, reason, height: level.height, fps: level.fps, at: this.now() });
    this.write(kept.slice(-MEMORY_LIMIT));
  }

  private read(): Entry[] {
    try {
      const entries = JSON.parse(this.storage?.getItem(MEMORY_KEY) ?? '[]') as Entry[];
      if (!Array.isArray(entries)) return [];
      const fresh = this.now() - MEMORY_DAYS * 86_400_000;
      return entries.filter((entry) => typeof entry?.at === 'number' && entry.at >= fresh);
    } catch {
      return [];
    }
  }

  private write(entries: Entry[]) {
    try {
      this.storage?.setItem(MEMORY_KEY, JSON.stringify(entries));
    } catch {
      /* Нет хранилища (приватный режим) — узнаем заново в следующий раз. */
    }
  }
}

/** Память этой страницы — `localStorage`, если он есть. */
export function pageCodecMemory(): CodecMemory {
  try {
    return typeof localStorage !== 'undefined' ? new StoredCodecMemory(localStorage) : NO_MEMORY;
  } catch {
    return NO_MEMORY;
  }
}
