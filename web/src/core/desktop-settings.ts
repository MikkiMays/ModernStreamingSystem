import { hasFeature, invokeDesktop, isDesktop, onDesktopEvent } from './desktop';
import { Store } from './store';

/**
 * Переключатели «мягкого взаимодействия с Windows» (T53, ADR 0001 §4.4) — раздел «Windows» в
 * настройках (E03). Живут в оболочке (`settings.json` клиента на Electron), а не в профиле
 * страницы: трей, панель задач, сон и автозапуск — свойства этой машины, а не сервера.
 *
 * Страница читает и меняет их запросом `invoke('app.settings', патч)`, а оболочка, сменив значение
 * сама (клавиша оверлея), присылает событие `app.settings`. Каждая строка раздела видна только при
 * своём флаге возможностей (`tray`, `thumbar`, `badge`, `attention`, `sleep`, `overlay`, `autostart`).
 */
export interface DesktopSettings {
  tray: boolean;
  thumbar: boolean;
  badge: boolean;
  flash: boolean;
  sleepBlocker: boolean;
  overlay: boolean;
  autostart: boolean;
}

const KEYS: readonly (keyof DesktopSettings)[] = [
  'tray',
  'thumbar',
  'badge',
  'flash',
  'sleepBlocker',
  'overlay',
  'autostart',
];

/** Последнее, что сказала оболочка; `null` — ещё не спрашивали. */
export const desktopSettings = new Store<DesktopSettings | null>(null);

/** Раздел есть только в оболочке, которая умеет `app.settings`. */
export function desktopSettingsAvailable(): boolean {
  return isDesktop() && hasFeature('app.settings');
}

/** Ответ оболочки без доверия: каждое значение — `true`/`false`, иначе ответа нет. */
export function parseDesktopSettings(answer: unknown): DesktopSettings | null {
  if (!answer || typeof answer !== 'object') return null;
  const data = answer as Record<string, unknown>;
  const parsed = {} as DesktopSettings;
  for (const key of KEYS) {
    if (typeof data[key] !== 'boolean') return null;
    parsed[key] = data[key];
  }
  return parsed;
}

export async function loadDesktopSettings(): Promise<DesktopSettings | null> {
  if (!desktopSettingsAvailable()) return null;
  try {
    const parsed = parseDesktopSettings(await invokeDesktop('app.settings', {}));
    if (parsed) desktopSettings.set(parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Сменить переключатель: на экране — сразу, потом — как ответила оболочка. Отказ возвращает
 * прежнее значение: переключатель не должен показывать то, чего не случилось.
 */
export async function changeDesktopSettings(patch: Partial<DesktopSettings>): Promise<void> {
  const before = desktopSettings.get();
  if (before) desktopSettings.set({ ...before, ...patch });
  try {
    const parsed = parseDesktopSettings(await invokeDesktop('app.settings', patch));
    if (parsed) desktopSettings.set(parsed);
  } catch {
    desktopSettings.set(before);
  }
}

/** Оболочка сменила значение сама (клавиша оверлея) — показать это в открытых настройках. */
export function watchDesktopSettings(): () => void {
  return onDesktopEvent('app.settings', (data) => {
    const parsed = parseDesktopSettings(data);
    if (parsed) desktopSettings.set(parsed);
  });
}

/** Клавиша оверлея в окне встречи (без Ctrl/Alt она не регистрируется в системе). */
export async function toggleDesktopOverlay(): Promise<void> {
  const current = desktopSettings.get() ?? (await loadDesktopSettings());
  if (current) await changeDesktopSettings({ overlay: !current.overlay });
}
