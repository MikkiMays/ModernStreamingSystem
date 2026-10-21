import { Store } from './store';
import type { Hotkey } from './hotkeys';

/**
 * Мост с оболочкой Windows.
 *
 * Два моста: **v2** — `window.cordDesktop` клиента на Electron (ADR 0001 §3: протокол 2, флаги
 * возможностей, `send`/`invoke`/`on`), и **v1** — `window.chrome.webview` клиента WinUI, пока он
 * жив. Страница везде говорит одним языком — именами v1 (`notifyDesktop`, `onDesktopCommand`), а
 * адаптер переводит их в v2 и обратно: 10 мест в интерфейсе не ветвятся по оболочке.
 *
 * Что умеет оболочка, страница узнаёт по **флагам** (`hasFeature('overlay')`), а не по номерам
 * версий. Неизвестные сообщения отбрасываются.
 */

/** Узкий API v2, который preload выставляет странице. */
interface CordDesktop {
  readonly protocol: { major: number; minor: number };
  readonly features: readonly string[];
  readonly app: { version: string; arch: string };
  readonly bootstrap: {
    profile: string;
    theme: string;
    showPing: boolean;
    notificationSounds: boolean;
    autoConnect: boolean;
  };
  send(type: string, payload?: object): void;
  invoke(method: string, payload?: object): Promise<unknown>;
  on(type: string, listener: (data: Record<string, unknown>) => void): () => void;
}

interface WebViewBridge {
  postMessage: (message: unknown) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent<unknown>) => void) => void;
  removeEventListener: (type: 'message', listener: (event: MessageEvent<unknown>) => void) => void;
}

declare global {
  interface Window {
    cordDesktop?: CordDesktop;
    chrome?: { webview?: WebViewBridge };
  }
}

function v2(): CordDesktop | null {
  const api = window.cordDesktop;
  return api && api.protocol?.major === 2 ? api : null;
}

/** Страница открыта внутри приложения Cord для Windows — любого из двух. */
export function isDesktop(): boolean {
  return !!v2() || !!window.chrome?.webview;
}

/**
 * Возможности WinUI (v1), выраженные теми же флагами: сочетание, серверы, обновление, рукопожатие и
 * своя боковая панель с избранным (`sidebar`) — у Electron её нет, главную рисует веб целиком.
 */
const V1_FEATURES = new Set(['hotkeys', 'servers', 'update', 'session', 'sidebar']);

export function desktopFeatures(): ReadonlySet<string> {
  const api = v2();
  if (api) return new Set(api.features);
  return window.chrome?.webview ? V1_FEATURES : new Set();
}

export function hasFeature(name: string): boolean {
  return desktopFeatures().has(name);
}

export const desktopHotkeyStatus = new Store<string | null>(null);
/** Что оболочка ответила про сочетание оверлея (`overlay.toggle`) — строкой, как и для микрофона. */
export const desktopOverlayHotkeyStatus = new Store<string | null>(null);

/**
 * Сочетания, которые страница отдала оболочке. Микрофон и оверлей уходят одним набором
 * (`hotkeys.configure` заменяет его целиком), поэтому адаптер помнит оба: экран встречи называет
 * оба, настройки — то, что меняют, и «паузу» на время записи нового сочетания — чтобы нажатие
 * самого сочетания записалось, а не включило микрофон или оверлей.
 */
const desktopHotkeys: { mic: Hotkey | null; overlay: Hotkey | null; paused: boolean } = {
  mic: null,
  overlay: null,
  paused: false,
};

function configureHotkeys(api: CordDesktop, data: Record<string, unknown>) {
  if ('hotkey' in data) desktopHotkeys.mic = (data.hotkey as Hotkey | null | undefined) ?? null;
  if ('overlay' in data) desktopHotkeys.overlay = (data.overlay as Hotkey | null | undefined) ?? null;
  if ('paused' in data) desktopHotkeys.paused = data.paused === true;
  const { mic, overlay, paused } = desktopHotkeys;
  api.send('hotkeys.configure', {
    bindings: paused
      ? []
      : [
          ...(mic ? [{ action: 'mic.toggle', mode: 'toggle', key: mic }] : []),
          ...(overlay ? [{ action: 'overlay.toggle', mode: 'toggle', key: overlay }] : []),
        ],
  });
}

/**
 * Что оболочка рассказала странице про обновление себя самой.
 *
 * Страница о файлах приложения ничего не знает и знать не должна: она умеет только попросить
 * проверить и показать ответ. Пустое состояние — «оболочка ещё ничего не сказала», и это не
 * то же самое, что «обновлений нет». В v2 номер версии приходит с мостом сразу — он нужен
 * только «О программе» (T58).
 */
export interface DesktopUpdate {
  version: string;
  status: string;
  available: boolean;
}
export const desktopUpdate = new Store<DesktopUpdate>({
  version: v2()?.app.version ?? '',
  status: '',
  available: false,
});
export function desktopVersion(state: DesktopUpdate) {
  return state.version;
}

export interface DesktopCommand {
  version: 1;
  type:
    | 'favorite.settings'
    | 'favorites.changed'
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
    | 'update.status'
    | 'deeplink'
    | 'thumbar';
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
  /** Код встречи из `cord://room/<код>` (`deeplink`). */
  code?: string;
  /** Кнопка на миниатюре в панели задач (`thumbar`). */
  action?: 'mic' | 'camera' | 'leave';
}

const COMMANDS: readonly DesktopCommand['type'][] = [
  'favorite.settings',
  'favorites.changed',
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
  'deeplink',
  'thumbar',
];

/** Имена v1 → v2 там, где они различаются; остальные совпадают. */
const SEND_V2: Record<string, string> = {
  'call-state': 'call.state',
  'close-ready': 'close.ready',
};

/** Разные имена, одно действие: страница зовёт v1, адаптер говорит с v2. */
export function notifyDesktop(type: string, data: Record<string, unknown> = {}) {
  const api = v2();
  if (!api) {
    // WinUI знает только сочетание микрофона: оверлея и паузы у него нет.
    if (type === 'hotkey.configure') {
      if ('hotkey' in data)
        window.chrome?.webview?.postMessage({ version: 1, type, hotkey: data.hotkey ?? null });
      return;
    }
    window.chrome?.webview?.postMessage({ version: 1, type, ...data });
    return;
  }
  switch (type) {
    case 'hotkey.configure':
      configureHotkeys(api, data);
      return;
    case 'update.version':
      void refreshUpdate(api);
      return;
    case 'update.check':
      api.send('update.check');
      // Оболочка ответит `update.status`, когда спросит зеркало; на всякий случай переспрашиваем сами.
      setTimeout(() => void refreshUpdate(api), 3000);
      return;
    case 'session.expired':
      // В v2 это запрос с ответом; `renew()` зовёт `askTheHost` только при флаге `session`.
      return;
    default:
      api.send(SEND_V2[type] ?? type, data);
  }
}

async function refreshUpdate(api: CordDesktop) {
  try {
    const answer = (await api.invoke('update.status')) as { status?: unknown; available?: unknown } | null;
    desktopUpdate.set({
      version: api.app.version,
      status: typeof answer?.status === 'string' ? answer.status : '',
      available: answer?.available === true,
    });
  } catch {
    /* оболочка без обновлений — строка остаётся пустой */
  }
}

/** Строка состояния сочетания из ответа v2 — по действию (`mic.toggle`, `overlay.toggle`). */
function hotkeyStatusText(status: unknown, action = 'mic.toggle'): string | null {
  if (!status || typeof status !== 'object') return null;
  const text = (status as Record<string, unknown>)[action];
  return typeof text === 'string' ? text : null;
}

export function onDesktopCommand(listener: (command: DesktopCommand) => void) {
  const api = v2();
  if (api) {
    const relay = (command: Partial<DesktopCommand>) =>
      listener({ version: 1, ...command } as DesktopCommand);
    const stops = [
      api.on('hotkey', (data) => {
        if (data.action === 'mic.toggle' && data.phase !== 'up') relay({ type: 'microphone.toggle' });
      }),
      api.on('hotkeys.status', (data) => {
        const detail = hotkeyStatusText(data.status);
        desktopHotkeyStatus.set(detail);
        desktopOverlayHotkeyStatus.set(hotkeyStatusText(data.status, 'overlay.toggle'));
        relay({ type: 'hotkey.status', detail: detail ?? undefined });
      }),
      api.on('update.status', (data) => {
        const next = {
          version: api.app.version,
          status: typeof data.status === 'string' ? data.status : '',
          available: data.available === true,
        };
        desktopUpdate.set(next);
        relay({ type: 'update.status', name: next.version, detail: next.status, available: next.available });
      }),
      api.on('deeplink', (data) => {
        const room = data.room as { code?: unknown; roomId?: unknown } | undefined;
        if (typeof room?.code === 'string') relay({ type: 'deeplink', code: room.code });
        else if (typeof room?.roomId === 'string') relay({ type: 'deeplink', roomId: room.roomId });
      }),
      api.on('thumbar', (data) => {
        if (data.action === 'mic' || data.action === 'camera' || data.action === 'leave')
          relay({ type: 'thumbar', action: data.action });
      }),
      ...(
        [
          'navigate',
          'theme.changed',
          'preferences.changed',
          'settings.open',
          'favorite.settings',
          'favorites.changed',
          'profile.changed',
          'network.changed',
          'close-request',
          'session.token',
        ] as const
      ).map((type) => api.on(type, (data) => relay({ ...(data as Partial<DesktopCommand>), type }))),
    ];
    return () => stops.forEach((stop) => stop());
  }
  const receive = ({ data }: MessageEvent<unknown>) => {
    if (!data || typeof data !== 'object') return;
    const message = data as Partial<DesktopCommand>;
    if (message.version !== 1 || !COMMANDS.includes(message.type as DesktopCommand['type'])) return;
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

/** Подписка на событие оболочки v2 под его собственным именем (`app.settings`); в v1 и в браузере — ничего. */
export function onDesktopEvent(type: string, listener: (data: Record<string, unknown>) => void): () => void {
  const api = v2();
  return api ? api.on(type, listener) : () => {};
}

/** Запрос к оболочке v2 с ответом; в v1 и в браузере — null. */
export function invokeDesktop(method: string, payload: object = {}): Promise<unknown> {
  const api = v2();
  return api ? api.invoke(method, payload) : Promise.resolve(null);
}
