import { hasFeature, invokeDesktop, isDesktop, onDesktopEvent } from './desktop';
import { Store } from './store';

/**
 * Переключатели «мягкого взаимодействия с Windows» (T53, ADR 0001 §4.4) — раздел «Windows» в
 * настройках (E03). Живут в оболочке (`settings.json` клиента на Electron), а не в профиле
 * страницы: трей, панель задач, сон и автозапуск — свойства этой машины, а не сервера.
 *
 * Страница читает и меняет их запросом `invoke('app.settings', патч)`, а оболочка, сменив значение
 * сама (клавиша оверлея), присылает событие `app.settings`. Каждая строка раздела видна только при
 * своём флаге возможностей (`tray`, `attention`, `sleep`, `overlay`, `autostart`).
 *
 * Кнопки на миниатюре и значок поверх иконки (`thumbar`, `badge`) убраны (R138): страница о них не
 * спрашивает и их не требует — оболочка 1.0.11 их больше не показывает, а 1.0.10 и старше прислала
 * бы, и это тоже годный ответ.
 *
 * Не только переключатели (R63, R93): виджет говорящих в игре — угол, размер аватара, имена,
 * прозрачность, всплывашка при старте игры (флаг `overlay.widget`) — и мини-окно звонка (флаг `mini`).
 * Оболочка до R63 этих значений не присылает (поля необязательные) и отказала бы патчу с ними —
 * поэтому их строки видны только при своих флагах.
 */
export type OverlayCorner = 'tl' | 'tr' | 'bl' | 'br';
export type OverlaySize = 's' | 'm' | 'l';
export type OverlayNames = 'always' | 'speaking' | 'never';
export const OVERLAY_CORNERS: readonly OverlayCorner[] = ['tl', 'tr', 'bl', 'br'];
export const OVERLAY_SIZES: readonly OverlaySize[] = ['s', 'm', 'l'];
export const OVERLAY_NAMES: readonly OverlayNames[] = ['always', 'speaking', 'never'];
export const OVERLAY_OPACITY = { min: 30, max: 100 } as const;

export interface DesktopSettings {
  tray: boolean;
  flash: boolean;
  sleepBlocker: boolean;
  overlay: boolean;
  autostart: boolean;
  /** Мини-окно звонка, когда Cord свёрнут (R93). */
  mini?: boolean;
  overlayCorner?: OverlayCorner;
  overlaySize?: OverlaySize;
  overlayNames?: OverlayNames;
  /** 30–100 %. */
  overlayOpacity?: number;
  /** Всплывашка «Показать игру» при старте игры (R104). */
  overlayToast?: boolean;
}

/** Переключатели, которые знает любая оболочка с `app.settings`: без любого из них ответа нет. */
export type DesktopSwitch =
  'tray' | 'flash' | 'sleepBlocker' | 'overlay' | 'autostart' | 'mini' | 'overlayToast';
const KEYS: readonly Exclude<DesktopSwitch, 'mini' | 'overlayToast'>[] = [
  'tray',
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
  // Значения виджета и мини-окна — только знакомые; незнакомое пропускается, а не роняет ответ.
  if (typeof data.mini === 'boolean') parsed.mini = data.mini;
  if (typeof data.overlayToast === 'boolean') parsed.overlayToast = data.overlayToast;
  if (OVERLAY_CORNERS.includes(data.overlayCorner as OverlayCorner))
    parsed.overlayCorner = data.overlayCorner as OverlayCorner;
  if (OVERLAY_SIZES.includes(data.overlaySize as OverlaySize))
    parsed.overlaySize = data.overlaySize as OverlaySize;
  if (OVERLAY_NAMES.includes(data.overlayNames as OverlayNames))
    parsed.overlayNames = data.overlayNames as OverlayNames;
  if (
    typeof data.overlayOpacity === 'number' &&
    Number.isInteger(data.overlayOpacity) &&
    data.overlayOpacity >= OVERLAY_OPACITY.min &&
    data.overlayOpacity <= OVERLAY_OPACITY.max
  )
    parsed.overlayOpacity = data.overlayOpacity;
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
