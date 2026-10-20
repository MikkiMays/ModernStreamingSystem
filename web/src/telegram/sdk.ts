import {
  backButton,
  closingBehavior,
  hapticFeedback,
  init,
  miniApp,
  openLink,
  retrieveLaunchParams,
  retrieveRawInitData,
  swipeBehavior,
  themeParams,
  viewport,
} from '@tma.js/sdk';
import { applyInsets, insetVariables } from './insets';
import { applyTheme, cordTheme, type TelegramTheme } from './theme';

/**
 * Тонкая обёртка над `@tma.js/sdk` (решение архитектора 17): всё, что Mini App Cord просит у Telegram,
 * — здесь, и SDK меняется в одном файле. Официальный `telegram-web-app.js` не берём: CSP шлюза
 * (`script-src 'self'`) не пускает скрипты с telegram.org, а в РФ этот запрос ещё и может не пройти.
 *
 * Каждое действие — «если клиент умеет» (`ifAvailable`): старый Telegram без полного экрана или без
 * безопасных зон просто остаётся в окне, ошибкой это не становится.
 */
export type Haptic = 'tap' | 'success' | 'error';

export interface TelegramShell {
  /** Сырая строка `initData` — уходит на сервер как есть, на неё одну и можно опираться. */
  initData: string;
  platform: string;
  /** Кнопка «Назад» Telegram: обработчик — показать, `null` — спрятать. */
  back(handler: (() => void) | null): void;
  haptic(kind: Haptic): void;
  /** Во встрече «✕» сначала спрашивает — случайный свайп не обрывает разговор. */
  confirmClosing(on: boolean): void;
  /** Ссылка во внешний браузер; только в ответ на действие человека. */
  openExternal(url: string): void;
  close(): void;
}

/** Телефоны — сразу на весь экран; Desktop и Web отвечают `UNSUPPORTED` и остаются в окне. */
const FULLSCREEN = new Set(['ios', 'android', 'android_x']);

function attempt(job: () => unknown) {
  try {
    const result = job();
    if (result && typeof (result as Promise<unknown>).catch === 'function')
      (result as Promise<unknown>).catch(() => {});
  } catch {
    /* Клиент не умеет — работаем без этого. */
  }
}

/** Mini App открыт внутри Telegram? Нет параметров запуска — это обычный браузер. */
export function launchedInTelegram(): boolean {
  try {
    return !!retrieveRawInitData();
  } catch {
    return false;
  }
}

export function startTelegram(): TelegramShell | null {
  if (!launchedInTelegram()) return null;
  let platform = 'unknown';
  try {
    init();
    platform = retrieveLaunchParams().tgWebAppPlatform;
  } catch {
    return null;
  }
  attempt(() => miniApp.mount.ifAvailable());
  attempt(() => themeParams.mount.ifAvailable());
  attempt(() => swipeBehavior.mount.ifAvailable());
  attempt(() => closingBehavior.mount.ifAvailable());
  attempt(() => backButton.mount.ifAvailable());

  /*
    Цвета — до `ready()`: заставка Telegram уходит на кадр того же цвета, что шапка и низ. Тема
    меняется и на ходу (переключили ночной режим) — тогда тоже.
  */
  const paint = () => {
    const theme = cordTheme((themeParams.state() ?? {}) as TelegramTheme);
    applyTheme(theme);
    const color = theme.background as `#${string}`;
    attempt(() => miniApp.setHeaderColor.ifAvailable(color));
    attempt(() => miniApp.setBgColor.ifAvailable(color));
    attempt(() => miniApp.setBottomBarColor.ifAvailable(color));
  };
  attempt(paint);
  attempt(() => themeParams.state.sub(paint));
  // Свайп по видео вниз не сворачивает приложение; свернуть можно за шапку Telegram.
  attempt(() => swipeBehavior.disableVertical.ifAvailable());

  void (async () => {
    try {
      await viewport.mount();
    } catch {
      return;
    }
    attempt(() => viewport.expand.ifAvailable());
    // `--tg-viewport-stable-height`: высота без рывков во время разворачивания (`telegram.css`).
    attempt(() => viewport.bindCssVars.ifAvailable());
    const insets = () =>
      applyInsets(insetVariables(viewport.safeAreaInsets(), viewport.contentSafeAreaInsets()));
    attempt(insets);
    attempt(() => viewport.safeAreaInsets.sub(insets));
    attempt(() => viewport.contentSafeAreaInsets.sub(insets));
    document.documentElement.dataset.telegramFullscreen = String(viewport.isFullscreen());
    attempt(() =>
      viewport.isFullscreen.sub((full) => {
        document.documentElement.dataset.telegramFullscreen = String(full);
      }),
    );
    if (FULLSCREEN.has(platform) && !viewport.isFullscreen())
      attempt(() => viewport.requestFullscreen.ifAvailable());
  })();

  // Статичная загрузка `tg.html` уже на экране — заставку Telegram можно убирать.
  attempt(() => miniApp.ready.ifAvailable());

  let backHandler: (() => void) | null = null;
  return {
    initData: retrieveRawInitData() ?? '',
    platform,
    back(handler) {
      if (backHandler) attempt(() => backButton.offClick.ifAvailable(backHandler!));
      backHandler = handler;
      if (handler) {
        attempt(() => backButton.onClick.ifAvailable(handler));
        attempt(() => backButton.show.ifAvailable());
      } else attempt(() => backButton.hide.ifAvailable());
    },
    haptic(kind) {
      if (kind === 'tap') attempt(() => hapticFeedback.impactOccurred.ifAvailable('light'));
      else attempt(() => hapticFeedback.notificationOccurred.ifAvailable(kind));
    },
    confirmClosing(on) {
      if (on) attempt(() => closingBehavior.enableConfirmation.ifAvailable());
      else attempt(() => closingBehavior.disableConfirmation.ifAvailable());
    },
    openExternal(url) {
      try {
        openLink(url);
      } catch {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    },
    close() {
      attempt(() => miniApp.close.ifAvailable());
    },
  };
}
