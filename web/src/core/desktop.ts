import { Store } from './store';
import type { Hotkey, MicHotkeyMode } from './hotkeys';
import type { Translate } from '../i18n';

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
    /**
     * Язык из установщика (R64); `null` — веб выбирает сам. Preload кладёт его в сохранённые
     * настройки один раз, если человек язык ещё не выбирал (`i18n/languages.ts`, `detectLanguage`).
     */
    language?: string | null;
    showPing: boolean;
    notificationSounds: boolean;
    autoConnect: boolean;
    /** Высота кнопок окна «— ⧉ ×» в DIP (`titleBarOverlay.height`, с 1.0.10); нет — 36 (`core/titlebar.ts`). */
    titlebarHeight?: number;
    /**
     * Общие для всех серверов настройки (R146, флаг `prefs.shared`): значения последней записи с любого
     * сервера. Preload уже положил их в `cord:preferences:v1` до первого скрипта; `devices` — названия
     * устройств, их сверяет `shared-preferences.ts`. Пусто — у оболочки общего ещё нет (перенос).
     */
    shared?: Record<string, unknown>;
    /** Токен Яндекс Музыки (R157): только серверу каталога; null — нет; '' — отключён. */
    yandexMusicToken?: string | null;
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
 * Какая оболочка: Electron (мост v2) или WinUI (WebView2, v1). Кодекам это важно (R152): ключи
 * Chromium вроде аппаратного AV1 для WebRTC ставит только своя оболочка, WebView2 — обычный Edge.
 */
export function desktopShell(): 'electron' | 'webview' | null {
  if (typeof window === 'undefined') return null;
  return v2() ? 'electron' : window.chrome?.webview ? 'webview' : null;
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

/** Что оболочка v2 отдала странице до первой отрисовки; в v1 и в браузере — null. */
export function desktopBootstrap(): CordDesktop['bootstrap'] | null {
  return v2()?.bootstrap ?? null;
}

/**
 * Состояние сочетания в системе — кодом оболочки (R22, X1). Слова берутся из каталога на языке
 * интерфейса (`hotkeyStatusText`), а не из оболочки: прежде она слала русскую фразу, и на семи
 * других языках посреди интерфейса стояла русская строка. `global` и `global-raw` («работает поверх
 * других программ») — норма, о ней не говорят; `disabled` — сочетания нет.
 */
export type HotkeyStatus = 'global' | 'global-raw' | 'taken' | 'duplicate' | 'window-only' | 'disabled';
const HOTKEY_STATUSES: readonly HotkeyStatus[] = [
  'global',
  'global-raw',
  'taken',
  'duplicate',
  'window-only',
  'disabled',
];
/** Код из ответа оболочки; русская фраза старой оболочки (1.0.4) и всё незнакомое — `null`. */
function hotkeyStatusCode(value: unknown): HotkeyStatus | null {
  return HOTKEY_STATUSES.includes(value as HotkeyStatus) ? (value as HotkeyStatus) : null;
}

/** Что сказать человеку о состоянии сочетания; `null` — говорить не о чем (работает как надо). */
export function hotkeyStatusText(t: Translate, status: HotkeyStatus | null): string | null {
  switch (status) {
    case 'taken':
      return t(($) => $.settings.hotkeys.status.taken);
    case 'duplicate':
      return t(($) => $.settings.hotkeys.status.duplicate);
    case 'window-only':
      return t(($) => $.settings.hotkeys.status.windowOnly);
    default:
      return null;
  }
}

export const desktopHotkeyStatus = new Store<HotkeyStatus | null>(null);
/** Что оболочка ответила про сочетание оверлея (`overlay.toggle`) — кодом, как и для микрофона. */
export const desktopOverlayHotkeyStatus = new Store<HotkeyStatus | null>(null);
/** И про разблокировку оверлея (`overlay.lock`, R63). */
export const desktopOverlayLockStatus = new Store<HotkeyStatus | null>(null);

/**
 * Сочетания, которые страница отдала оболочке. Микрофон и оверлей уходят одним набором
 * (`hotkeys.configure` заменяет его целиком), поэтому адаптер помнит оба: экран встречи называет
 * оба, настройки — то, что меняют, и «паузу» на время записи нового сочетания — чтобы нажатие
 * самого сочетания записалось, а не включило микрофон или оверлей.
 *
 * Микрофон в режиме «нажми и говори» (`mode: 'hold'`) уходит действием `ptt` с удержанием — только
 * при флаге `ptt` (Raw Input в `cord-native`): `globalShortcut` фазы «отпустил» не знает, и
 * удержание без неё оставило бы микрофон включённым. Без флага — прежнее переключение.
 *
 * Разблокировка оверлея (`overlay.lock`, R63) и клавиша «`» (`Backquote`) — только при флаге
 * `overlay.widget`: оболочка до R63 их не знает и отбросила бы весь набор, а с ним и микрофон.
 */
const desktopHotkeys: {
  mic: Hotkey | null;
  overlay: Hotkey | null;
  lock: Hotkey | null;
  /** «Звук встречи» (R156): действие `deafen` оболочка знает с E01-B2. */
  deafen: Hotkey | null;
  paused: boolean;
  micMode: MicHotkeyMode;
} = {
  mic: null,
  overlay: null,
  lock: null,
  deafen: null,
  paused: false,
  micMode: 'toggle',
};

function configureHotkeys(api: CordDesktop, data: Record<string, unknown>) {
  if ('hotkey' in data) desktopHotkeys.mic = (data.hotkey as Hotkey | null | undefined) ?? null;
  if ('overlay' in data) desktopHotkeys.overlay = (data.overlay as Hotkey | null | undefined) ?? null;
  if ('lock' in data) desktopHotkeys.lock = (data.lock as Hotkey | null | undefined) ?? null;
  if ('deafen' in data) desktopHotkeys.deafen = (data.deafen as Hotkey | null | undefined) ?? null;
  if ('paused' in data) desktopHotkeys.paused = data.paused === true;
  if ('mode' in data) desktopHotkeys.micMode = data.mode === 'hold' ? 'hold' : 'toggle';
  const widget = api.features.includes('overlay.widget');
  // Сочетание, которого эта оболочка не знает, не уходит вовсе — иначе она отбросит весь набор.
  const known = (key: Hotkey | null) => (key && (widget || key.code !== 'Backquote') ? key : null);
  const mic = known(desktopHotkeys.mic);
  const overlay = known(desktopHotkeys.overlay);
  const lock = widget ? desktopHotkeys.lock : null;
  // Кнопок мыши у «звука встречи» нет — без Raw Input оболочка их не зарегистрирует.
  const deafen = known(desktopHotkeys.deafen);
  const { paused, micMode } = desktopHotkeys;
  const hold = micMode === 'hold' && api.features.includes('ptt');
  api.send('hotkeys.configure', {
    bindings: paused
      ? []
      : [
          ...(mic
            ? [
                hold
                  ? { action: 'ptt', mode: 'hold', key: mic }
                  : { action: 'mic.toggle', mode: 'toggle', key: mic },
              ]
            : []),
          ...(overlay ? [{ action: 'overlay.toggle', mode: 'toggle', key: overlay }] : []),
          ...(lock ? [{ action: 'overlay.lock', mode: 'toggle', key: lock }] : []),
          ...(deafen ? [{ action: 'deafen', mode: 'toggle', key: deafen }] : []),
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
    | 'microphone.hold'
    | 'deafen.toggle'
    | 'hotkey.status'
    | 'session.token'
    | 'settings.open'
    | 'profile.changed'
    | 'update.status'
    | 'deeplink'
    | 'thumbar'
    | 'chat.open';
  /** «Нажми и говори» (`microphone.hold`, только v2 с флагом `ptt`): нажали или отпустили. */
  phase?: 'down' | 'up';
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

/** Код состояния сочетания из ответа v2 — по действию (`mic.toggle`, `overlay.toggle`, `ptt`). */
function hotkeyStatusOf(status: unknown, action = 'mic.toggle'): HotkeyStatus | null {
  if (!status || typeof status !== 'object') return null;
  return hotkeyStatusCode((status as Record<string, unknown>)[action]);
}

export function onDesktopCommand(listener: (command: DesktopCommand) => void) {
  const api = v2();
  if (api) {
    const relay = (command: Partial<DesktopCommand>) =>
      listener({ version: 1, ...command } as DesktopCommand);
    const stops = [
      api.on('hotkey', (data) => {
        if (data.action === 'mic.toggle' && data.phase !== 'up') relay({ type: 'microphone.toggle' });
        if (data.action === 'ptt' && (data.phase === 'down' || data.phase === 'up'))
          relay({ type: 'microphone.hold', phase: data.phase });
        if (data.action === 'deafen' && data.phase !== 'up') relay({ type: 'deafen.toggle' });
      }),
      api.on('hotkeys.status', (data) => {
        // В наборе микрофон — одним из двух действий: переключение или «нажми и говори».
        const detail = hotkeyStatusOf(data.status) ?? hotkeyStatusOf(data.status, 'ptt');
        desktopHotkeyStatus.set(detail);
        desktopOverlayHotkeyStatus.set(hotkeyStatusOf(data.status, 'overlay.toggle'));
        desktopOverlayLockStatus.set(hotkeyStatusOf(data.status, 'overlay.lock'));
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
          // «Чат · N» в меню трея (R103): открыть чат встречи — его открывает сама встреча.
          'chat.open',
        ] as const
      ).map((type) => api.on(type, (data) => relay({ ...(data as Partial<DesktopCommand>), type }))),
    ];
    return () => stops.forEach((stop) => stop());
  }
  const receive = ({ data }: MessageEvent<unknown>) => {
    if (!data || typeof data !== 'object') return;
    const message = data as Partial<DesktopCommand>;
    if (message.version !== 1 || !COMMANDS.includes(message.type as DesktopCommand['type'])) return;
    if (message.type === 'hotkey.status') desktopHotkeyStatus.set(hotkeyStatusCode(message.detail));
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

/**
 * Нажатие в уведомлении Windows (R59): кнопка (`admit`, `deny`) или сам toast (`open`) и `tag` того
 * уведомления. Оболочка уже подняла окно; встреча решает, что открыть.
 */
export function onNotificationAction(listener: (action: { id: string; tag: string }) => void): () => void {
  return onDesktopEvent('notification.action', (data) => {
    if (typeof data.id === 'string' && typeof data.tag === 'string') listener({ id: data.id, tag: data.tag });
  });
}

/** Запрос к оболочке v2 с ответом; в v1 и в браузере — null. */
export function invokeDesktop(method: string, payload: object = {}): Promise<unknown> {
  const api = v2();
  return api ? api.invoke(method, payload) : Promise.resolve(null);
}
