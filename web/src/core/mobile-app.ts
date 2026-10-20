/**
 * Мост с приложением Cord для телефона (оболочка Capacitor, `mobile/`).
 *
 * Оболочка грузит ту же страницу с сервера и подкладывает в неё мост Capacitor (`window.Capacitor`,
 * `native-bridge.js`): страница здесь — тот же клиент, что в браузере. `@capacitor/core` в сборку
 * веба не тянется: из моста нужны три вызова — `isNativePlatform`, `nativePromise` и `addListener`,
 * — и они есть в самом мосте, без библиотеки.
 *
 * Что даёт оболочка, чего нет в браузере (`docs/mobile.md` §4): свой foreground service на время
 * разговора — уведомление «Идёт разговор» в шторке, и Android не выгружает процесс с микрофоном,
 * сколько бы экран ни был погашен. Страница говорит оболочке «разговор начался» и «кончился»;
 * оболочка говорит странице, что нажали в уведомлении («Завершить», «Микрофон»).
 *
 * Плагин в оболочке — `CordCall` (`mobile/android/app/src/main/java/tech/nikg/cord/CordCallPlugin.java`).
 */
import { currentPlatform } from '../media/platform';

export const CALL_PLUGIN = 'CordCall';

/** Нажатия в уведомлении разговора. */
export type AppCommand = 'hangup' | 'microphone';

interface ListenerHandle {
  remove: () => Promise<void> | void;
}

/** Та часть моста Capacitor, которой пользуется страница. */
export interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  nativePromise?: (plugin: string, method: string, options?: object) => Promise<unknown>;
  addListener?: (plugin: string, event: string, callback: (data: unknown) => void) => ListenerHandle;
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge;
  }
}

function bridge(): CapacitorBridge | null {
  if (typeof window === 'undefined') return null;
  const cap = window.Capacitor;
  try {
    return cap?.isNativePlatform?.() === true ? cap : null;
  } catch {
    return null;
  }
}

/** Страница открыта внутри приложения Cord для телефона. */
export function isMobileApp(): boolean {
  return currentPlatform().app;
}

/**
 * Разговор начался или сменил название — оболочка поднимает (или обновляет) уведомление разговора.
 * Вызывать, пока приложение на экране: Android 14 разрешает foreground service с микрофоном только
 * из видимого приложения (while-in-use).
 */
export async function callStarted(info: { title: string; microphone: boolean }): Promise<boolean> {
  const cap = bridge();
  if (!cap?.nativePromise) return false;
  try {
    await cap.nativePromise(CALL_PLUGIN, 'start', info);
    return true;
  } catch (error) {
    // Нет разрешения на микрофон или старая оболочка без плагина: разговор идёт как в браузере.
    console.warn('[cord] mobile call service did not start', error);
    return false;
  }
}

/** Разговор кончился — уведомление уходит, foreground service останавливается. */
export async function callEnded(): Promise<void> {
  const cap = bridge();
  if (!cap?.nativePromise) return;
  await cap.nativePromise(CALL_PLUGIN, 'stop').catch(() => {});
}

/** Подписка на нажатия в уведомлении разговора. Возвращает отписку. */
export function onAppCommand(listener: (command: AppCommand) => void): () => void {
  const cap = bridge();
  if (!cap?.addListener) return () => {};
  const handle = cap.addListener(CALL_PLUGIN, 'command', (data) => {
    const action = (data as { action?: unknown } | null)?.action;
    if (action === 'hangup' || action === 'microphone') listener(action);
  });
  return () => void handle.remove();
}
