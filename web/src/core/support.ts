import type { CallReport } from '../media/call-quality';
import { appVersion } from './version';

/**
 * Поддержка (E13, T36): темы обращения, «Сообщить о проблеме» (R79) и диагностика, которую человек
 * может приложить к обращению — только сам и только видя, что именно уйдёт.
 *
 * Механизм решён в `DECISIONS.md` (E13-1): своя форма → база ядра → бот в Telegram владельца →
 * страница «Активность». Готовые службы поддержки (Chatwoot, Zammad, FreeScout) для одного владельца
 * без учётных записей тяжелее, чем польза от них.
 */
export const SUPPORT_TOPICS = ['camera', 'sound', 'screen', 'network', 'windows', 'idea', 'other'] as const;
export type SupportTopic = (typeof SUPPORT_TOPICS)[number];

/** Частые вопросы страницы «Помощь» — по порядку; тексты — `support.faq.items.<id>`. */
export const FAQ = [
  'camera',
  'microphone',
  'silent',
  'screen',
  'smartscreen',
  'network',
  'micBadge',
] as const;
export type FaqId = (typeof FAQ)[number];

/**
 * «Сообщить о проблеме» (R79): что не так во встрече — по порядку; подписи —
 * `support.report.issues.<id>`. Ядро знает тот же список (`SupportService.ISSUES`) и чужого слова
 * не примет.
 */
export const ISSUES = ['sound', 'screen', 'music', 'connect', 'other'] as const;
export type Issue = (typeof ISSUES)[number];

/** Короче не обращение: «ой» и пустые строки ядро не примет (`SUPPORT_TEXT`). */
export const MIN_MESSAGE = 10;
export const MAX_MESSAGE = 4000;
export const MAX_CONTACT = 200;

export interface SupportTicket {
  /** `report` — «Сообщить о проблеме»: тема — выбранное в `issues`. */
  topic: SupportTopic | 'report';
  message: string;
  contact: string | null;
  diagnostics: string | null;
  consent: boolean;
  issues?: Issue[];
}

export interface SupportReceipt {
  id: string;
  number: string;
}

/** Почему форма не уходит; `null` — уходит. */
export function ticketProblem(message: string): 'tooShort' | 'tooLong' | null {
  const text = message.trim();
  if ([...text].length < MIN_MESSAGE) return 'tooShort';
  if (text.length > MAX_MESSAGE) return 'tooLong';
  return null;
}

/** Что уходит на сервер: пустой контакт — нет контакта, диагностика — только с согласием. */
export function ticket(
  topic: SupportTopic,
  message: string,
  contact: string,
  consent: boolean,
  diagnostics: string,
): SupportTicket {
  return {
    topic,
    message: message.trim(),
    contact: contact.trim() ? contact.trim().slice(0, MAX_CONTACT) : null,
    diagnostics: consent ? diagnostics : null,
    consent,
  };
}

/**
 * Почему «Сообщить о проблеме» не уходит; `null` — уходит. Выбранного достаточно: подробности —
 * по желанию, а не «хотя бы одним предложением», как у обычного обращения.
 */
export function reportProblem(issues: readonly Issue[], message: string): 'noIssues' | 'tooLong' | null {
  if (!issues.length) return 'noIssues';
  if (message.trim().length > MAX_MESSAGE) return 'tooLong';
  return null;
}

/** «Сообщить о проблеме»: выбранное по порядку списка, отчёт — только с согласием. */
export function problemReport(
  issues: readonly Issue[],
  message: string,
  contact: string,
  consent: boolean,
  diagnostics: string,
): SupportTicket {
  return {
    ...ticket('other', message, contact, consent, diagnostics),
    topic: 'report',
    issues: ISSUES.filter((issue) => issues.includes(issue)),
  };
}

/**
 * Итог звонка строками для обращения и «Скопировать отчёт о звонке» (R79, R29): только числа и слова
 * из перечислений — ровно то, что ядро и так получает в конце звонка (`client-report`), без имён,
 * адресов и названий устройств. `null` — звонка не было (короче десяти секунд).
 */
export function callReportText(report: CallReport | null): string {
  if (!report) return 'call: none';
  const value = (number: number | null, unit: string) => (number === null ? 'n/a' : `${number} ${unit}`);
  return [
    `call: ${report.seconds} s`,
    `path: ${report.path}`,
    `rtt: ${value(report.rttMs, 'ms')}`,
    `loss: ${value(report.lossPercent, '%')}`,
    `jitter: ${value(report.jitterMs, 'ms')}`,
    `bitrate: ${value(report.bitrateKbps, 'kbps')}`,
    `lossy: ${report.lossySeconds} s`,
    `freezes: ${report.freezes} (${report.freezeSeconds} s)`,
    `codec: ${report.codec ?? 'n/a'}`,
  ].join('\n');
}

/* ---------- последние ошибки клиента ----------
   Кольцо из десяти строк в памяти вкладки: код отказа сервера или текст необработанной ошибки,
   без адресов и содержимого. Нужны они только для обращения — и уходят, только если человек
   отметил «Приложить диагностику». */
const RECENT = 10;
const errors: string[] = [];

export function noteError(text: string) {
  const line = text
    .replace(/https?:\/\/\S+/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  if (!line) return;
  const time = new Date().toTimeString().slice(0, 8);
  errors.push(`${time} ${line}`);
  if (errors.length > RECENT) errors.splice(0, errors.length - RECENT);
}

export function recentErrors(): readonly string[] {
  return [...errors];
}

/** Слушать необработанные ошибки страницы — один раз, из `main.tsx`. */
export function watchErrors(target: Window = window) {
  target.addEventListener('error', (event) => noteError(event.message || 'error'));
  target.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    noteError(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
  });
}

/** Окружение для диагностики; в тестах подставляется. */
export interface Environment {
  userAgent: string;
  language: string;
  screen: string;
  network?: string;
  /** Версия приложения для Windows, если страница открыта в нём. */
  desktop?: string;
}

function environment(): Environment {
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection;
  const desktop = window.cordDesktop?.app?.version;
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    screen: `${screen.width}×${screen.height} @${Math.round(devicePixelRatio * 100) / 100}x`,
    ...(connection?.effectiveType ? { network: connection.effectiveType } : {}),
    ...(desktop ? { desktop } : {}),
  };
}

/** Браузер и версия из строки агента: «Edge 141», «Chrome 141», «Firefox 140», «Safari 18». */
export function browserName(userAgent: string): string {
  const pick = (pattern: RegExp, name: string) => {
    const match = pattern.exec(userAgent);
    return match ? `${name} ${match[1]}` : null;
  };
  return (
    pick(/Edg\/(\d+)/, 'Edge') ??
    pick(/OPR\/(\d+)/, 'Opera') ??
    pick(/YaBrowser\/(\d+)/, 'Yandex') ??
    pick(/Firefox\/(\d+)/, 'Firefox') ??
    pick(/Chrome\/(\d+)/, 'Chrome') ??
    pick(/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari/, 'Safari') ??
    'unknown'
  );
}

/** Система из строки агента — без версий там, где браузер их больше не говорит честно. */
export function systemName(userAgent: string): string {
  if (/Android/.test(userAgent)) return 'Android';
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
  if (/Windows/.test(userAgent)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'macOS';
  if (/CrOS/.test(userAgent)) return 'ChromeOS';
  if (/Linux/.test(userAgent)) return 'Linux';
  return 'unknown';
}

/**
 * Диагностика обращения — ровно то, что человек увидит в «Что будет отправлено». Ключи по-английски:
 * это строки для разбора, а не текст интерфейса, и читает их владелец, а не собеседник.
 */
export function diagnosticsText(env: Environment = environment(), log: readonly string[] = errors): string {
  const lines = [
    `cord: ${appVersion}`,
    `client: ${env.desktop ? `windows ${env.desktop}` : 'web'}`,
    `browser: ${browserName(env.userAgent)}`,
    `os: ${systemName(env.userAgent)}`,
    `language: ${env.language}`,
    `screen: ${env.screen}`,
    ...(env.network ? [`network: ${env.network}`] : []),
    log.length ? 'errors:' : 'errors: none',
    ...log.map((line) => `  ${line}`),
  ];
  return lines.join('\n').trimEnd();
}
