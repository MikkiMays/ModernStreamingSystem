import { Store } from './store';
export const desktopHotkeyStatus = new Store<string | null>(null);
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
    | 'profile.changed';
  showPing?: boolean;
  notificationSounds?: boolean;
  page?: 'home' | 'create' | 'favorite';
  roomId?: string;
  theme?: 'light' | 'dark' | 'system';
  name?: string;
  detail?: string;
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
        'profile.changed',
      ].includes(message.type ?? '')
    )
      return;
    if (message.type === 'hotkey.status' && typeof message.detail === 'string')
      desktopHotkeyStatus.set(message.detail);
    listener(message as DesktopCommand);
  };
  const bridge = window.chrome?.webview;
  bridge?.addEventListener('message', receive);
  return () => bridge?.removeEventListener('message', receive);
}
