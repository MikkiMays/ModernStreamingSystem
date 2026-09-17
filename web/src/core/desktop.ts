import { Store } from './store';
export const desktopHotkeyStatus = new Store<string | null>(null);

/**
 * Что оболочка рассказала странице про обновление себя самой.
 *
 * Страница о файлах приложения ничего не знает и знать не должна: она умеет только попросить
 * проверить и показать ответ. Пустое состояние — «оболочка ещё ничего не сказала», и это не
 * то же самое, что «обновлений нет».
 */
export interface DesktopUpdate {
  version: string;
  status: string;
  available: boolean;
}
export const desktopUpdate = new Store<DesktopUpdate>({ version: '', status: '', available: false });
export function desktopVersion(state: DesktopUpdate) {
  return state.version;
}
export interface DesktopCommand {
  version: 1;
  type:
    | 'favorite.settings'
    | 'preferences.changed'
    | 'navigate'
    | 'network.changed'
    | 'close-request'
    | 'theme.changed'
    | 'microphone.toggle'
    | 'hotkey.status'
    | 'session.token'
    | 'settings.open'
    | 'profile.changed'
    | 'update.status';
  showPing?: boolean;
  notificationSounds?: boolean;
  page?: 'home' | 'create' | 'favorite';
  roomId?: string;
  theme?: 'light' | 'dark' | 'system';
  name?: string;
  detail?: string;
  /** A server session the host obtained for us; the page never sees the password. */
  token?: string;
  expiresAt?: number;
  serverName?: string;
  /** Which settings section to open, when the host asks for one. */
  tab?: string;
  /** Версия установленного приложения и что с обновлением, для `update.status`. */
  available?: boolean;
}
interface WebViewBridge {
  postMessage: (message: unknown) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent<unknown>) => void) => void;
  removeEventListener: (type: 'message', listener: (event: MessageEvent<unknown>) => void) => void;
}
declare global {
  interface Window {
    chrome?: { webview?: WebViewBridge };
  }
}
export function notifyDesktop(type: string, data: Record<string, unknown> = {}) {
  window.chrome?.webview?.postMessage({ version: 1, type, ...data });
}
export function onDesktopCommand(listener: (command: DesktopCommand) => void) {
  const receive = ({ data }: MessageEvent<unknown>) => {
    if (!data || typeof data !== 'object') return;
    const message = data as Partial<DesktopCommand>;
    if (
      message.version !== 1 ||
      ![
        'favorite.settings',
        'preferences.changed',
        'navigate',
        'network.changed',
        'close-request',
        'theme.changed',
        'microphone.toggle',
        'hotkey.status',
        'session.token',
        'settings.open',
        'profile.changed',
        'update.status',
      ].includes(message.type ?? '')
    )
      return;
    if (message.type === 'hotkey.status' && typeof message.detail === 'string')
      desktopHotkeyStatus.set(message.detail);
    if (message.type === 'update.status')
      desktopUpdate.set({
        version: typeof message.name === 'string' ? message.name : desktopUpdate.get().version,
        status: typeof message.detail === 'string' ? message.detail : '',
        available: message.available === true,
      });
    listener(message as DesktopCommand);
  };
  const bridge = window.chrome?.webview;
  bridge?.addEventListener('message', receive);
  return () => bridge?.removeEventListener('message', receive);
}
