/**
 * Отстал ли этот сервер от проекта.
 *
 * ЗАЧЕМ. Клиент для Windows проверяет себя сам, а сервер не проверял ничего: человек,
 * поднявший Cord у себя, узнавал о починенном багe только если сам заглядывал в репозиторий.
 * Обновиться при этом стоит одной команды — `./update.sh`, — так что молчать тут особенно
 * нечестно.
 *
 * КАК. Сборка знает коммит, из которого собрана (`core/version.ts`), а GitHub умеет
 * сравнивать два указателя одним запросом. Ответ даёт ровно то, что нужно:
 *
 *   status: 'identical'          — сервер на последнем, показывать нечего
 *   status: 'ahead', ahead_by: N — main ушёл вперёд на N коммитов
 *   404                          — коммита в репозитории нет: форк, своя ветка или сборка
 *                                  без git. Гадать не о чем, показывать тоже нечего.
 *
 * Важно, что молчание — это нормальный, а не исключительный исход: плашка появляется только
 * когда есть что сказать. «Всё актуально» человек и так видит по отсутствию плашки.
 */
import { appBuild } from './version';

export const CORE_REPOSITORY = 'MikkiMays/ModernStreamingSystem';
export const CORE_REPOSITORY_URL = `https://github.com/${CORE_REPOSITORY}`;

export interface UpstreamState {
  /** На сколько коммитов main впереди этой сборки. */
  behind: number;
}

let asked: Promise<UpstreamState | null> | undefined;

/** Спрашивается один раз за загрузку страницы и делится между всеми, кто спросил. */
export function upstreamState(): Promise<UpstreamState | null> {
  asked ??= load().catch(() => null);
  return asked;
}

async function load(): Promise<UpstreamState | null> {
  // Сборка без коммита — обычно сборка не из git. Сравнивать нечего.
  if (!/^[0-9a-f]{7,40}$/.test(appBuild)) return null;
  const response = await fetch(`https://api.github.com/repos/${CORE_REPOSITORY}/compare/${appBuild}...main`, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { status?: unknown; ahead_by?: unknown };
  if (data.status !== 'ahead' || typeof data.ahead_by !== 'number' || data.ahead_by <= 0) return null;
  return { behind: data.ahead_by };
}

/** «7 коммитов», «1 коммит», «22 коммита» — русскому счёту нужен не один суффикс. */
export function commitsLabel(count: number): string {
  const tail = count % 100 >= 11 && count % 100 <= 14 ? 0 : count % 10;
  const word = tail === 1 ? 'коммит' : tail >= 2 && tail <= 4 ? 'коммита' : 'коммитов';
  return `${count} ${word}`;
}
