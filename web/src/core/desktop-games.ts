import { hasFeature, invokeDesktop, isDesktop, onDesktopEvent } from './desktop';
import { Store } from './store';

/**
 * Игры клиента Windows (R62): что оболочка узнала сама (игра «без рамки», в эксклюзивном режиме или
 * из списка известных) или что человек добавил, и игра, которая запущена сейчас. Реестр живёт в
 * оболочке (`settings.games`), веб его только показывает и меняет: переключатель оверлея над игрой,
 * «Забыть», «Добавить игру». Как «Зарегистрированные игры» Discord, но без IGDB и без
 * конфиденциальности активности — аккаунтов в Cord нет (X2).
 *
 * Запросы — `invoke('games.list' | 'games.set' | 'games.forget' | 'games.pick')` с ответом
 * `{games, active}`; оболочка сама сообщает `games.changed {games, active}` и `game.active {game}`.
 * Только при флаге `games` (он требует `cord-native`). Схема — `contracts/desktop-bridge.v2.schema.json`.
 */
export interface DesktopGame {
  exe: string;
  name: string;
  /** Оверлей над этой игрой. */
  enabled: boolean;
  /** Мс эпохи; 0 — ещё не запускалась (добавлена вручную). */
  lastSeen: number;
}

export interface ActiveGame {
  exe: string;
  name: string;
  enabled: boolean;
  /** Эксклюзивный полноэкранный режим — оверлей не виден. */
  exclusive: boolean;
}

export interface DesktopGames {
  games: DesktopGame[];
  active: ActiveGame | null;
}

/** Последнее, что сказала оболочка; `null` — ещё не спрашивали. */
export const desktopGames = new Store<DesktopGames | null>(null);

export function gamesAvailable(): boolean {
  return isDesktop() && hasFeature('games');
}

const EXE = /^[^\\/:*?"<>|]{1,120}\.exe$/i;

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function readActive(value: unknown): ActiveGame | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (typeof data.exe !== 'string' || !EXE.test(data.exe)) return null;
  return {
    exe: data.exe,
    name: text(data.name, 80) || data.exe,
    enabled: data.enabled !== false,
    exclusive: data.exclusive === true,
  };
}

/** Ответ оболочки без доверия: только игры с именем exe, не больше сотни. */
export function parseDesktopGames(answer: unknown): DesktopGames | null {
  if (!answer || typeof answer !== 'object') return null;
  const data = answer as Record<string, unknown>;
  if (!Array.isArray(data.games)) return null;
  const games: DesktopGame[] = [];
  for (const item of data.games.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.exe !== 'string' || !EXE.test(entry.exe)) continue;
    games.push({
      exe: entry.exe,
      name: text(entry.name, 80) || entry.exe,
      enabled: entry.enabled !== false,
      lastSeen: typeof entry.lastSeen === 'number' && Number.isFinite(entry.lastSeen) ? entry.lastSeen : 0,
    });
  }
  return { games, active: readActive(data.active) };
}

async function ask(method: string, payload: object = {}): Promise<DesktopGames | null> {
  if (!gamesAvailable()) return null;
  try {
    const parsed = parseDesktopGames(await invokeDesktop(method, payload));
    if (parsed) desktopGames.set(parsed);
    return parsed;
  } catch {
    return null;
  }
}

export const loadDesktopGames = () => ask('games.list');

/** Переключатель игры: на экране — сразу, потом — как ответила оболочка. */
export async function setDesktopGame(exe: string, enabled: boolean): Promise<void> {
  const before = desktopGames.get();
  if (before)
    desktopGames.set({
      games: before.games.map((game) => (game.exe === exe ? { ...game, enabled } : game)),
      active: before.active?.exe === exe ? { ...before.active, enabled } : before.active,
    });
  if (!(await ask('games.set', { exe, enabled }))) desktopGames.set(before);
}

export const forgetDesktopGame = (exe: string) => ask('games.forget', { exe });

/** «Добавить игру»: оболочка открывает выбор exe и отвечает реестром после добавления. */
export const pickDesktopGame = () => ask('games.pick');

/** Оболочка сменила реестр или игру «сейчас» сама. */
export function watchDesktopGames(): () => void {
  const stops = [
    onDesktopEvent('games.changed', (data) => {
      const parsed = parseDesktopGames(data);
      if (parsed) desktopGames.set(parsed);
    }),
    onDesktopEvent('game.active', (data) => {
      const current = desktopGames.get();
      if (current) desktopGames.set({ ...current, active: readActive(data.game) });
    }),
  ];
  return () => stops.forEach((stop) => stop());
}
