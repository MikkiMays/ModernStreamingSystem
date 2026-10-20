/**
 * На каком телефоне идёт встреча — с точки зрения того, что ОС делает со звонком в фоне.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ ВЁРСТКИ. Вёрстка спрашивает ширину и `pointer: coarse`, а фон решает ОС: iPhone
 * в Safari держит разговор, пока жив захват микрофона, а тот же iPhone с экрана «Домой» глушит
 * микрофон, как только с экрана уходят; Android держит вкладку, пока страница захватывает
 * микрофон (`docs/mobile.md` §1). Планшет с клавиатурой — тот же телефон для ОС, а узкое окно на
 * ПК — нет. Поэтому признак — система, а не размер.
 *
 * iPadOS 13+ называет себя «Macintosh»: отличить его от Mac можно только по касанию.
 */
export type MobileOs = 'ios' | 'android' | 'other';

export interface Platform {
  os: MobileOs;
  /** Телефон или планшет: в фоне действуют правила мобильной ОС. */
  mobile: boolean;
  /**
   * Открыто как установленное веб-приложение: с экрана «Домой» на iOS (`navigator.standalone`) или
   * PWA (`display-mode: standalone`).
   */
  standalone: boolean;
  /** Внутри приложения Cord для телефона (оболочка Capacitor, `mobile/`). */
  app: boolean;
}

export interface PlatformSignals {
  userAgent: string;
  maxTouchPoints: number;
  /** `navigator.standalone` — только iOS. */
  iosStandalone?: boolean;
  /** `matchMedia('(display-mode: standalone)')`. */
  displayStandalone: boolean;
  /** Мост оболочки Capacitor ответил, что это родная платформа. */
  nativeBridge: boolean;
}

/** Метка приложения Cord в User-Agent (`appendUserAgent` в `mobile/capacitor.config.json`). */
export const APP_USER_AGENT = /\bCordApp\/\d/;

export function detectPlatform(signals: PlatformSignals): Platform {
  const ua = signals.userAgent;
  const ios = /\b(iPhone|iPad|iPod)\b/.test(ua) || (/\bMacintosh\b/.test(ua) && signals.maxTouchPoints > 1);
  const android = !ios && /\bAndroid\b/.test(ua);
  const os: MobileOs = ios ? 'ios' : android ? 'android' : 'other';
  const app = signals.nativeBridge || APP_USER_AGENT.test(ua);
  return {
    os,
    mobile: os !== 'other',
    // В оболочке страница всегда «во весь экран», но это не веб-приложение «Домой»: фоном там
    // управляет сама оболочка, а не правила WebKit для веб-приложений.
    standalone: !app && (signals.iosStandalone === true || signals.displayStandalone),
    app,
  };
}

interface CapacitorProbe {
  Capacitor?: { isNativePlatform?: () => boolean };
}

/** Платформа этой страницы. Без `window` (тесты, сборка) — обычный ПК. */
export function currentPlatform(): Platform {
  if (typeof window === 'undefined' || typeof navigator === 'undefined')
    return { os: 'other', mobile: false, standalone: false, app: false };
  let displayStandalone = false;
  try {
    displayStandalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  } catch {
    /* Старый движок без matchMedia: значит, и не установлено. */
  }
  let nativeBridge = false;
  try {
    nativeBridge = (window as unknown as CapacitorProbe).Capacitor?.isNativePlatform?.() === true;
  } catch {
    /* Мост есть, но сломан — считаем, что его нет: страница работает как в браузере. */
  }
  return detectPlatform({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    iosStandalone: (navigator as { standalone?: boolean }).standalone,
    displayStandalone,
    nativeBridge,
  });
}
