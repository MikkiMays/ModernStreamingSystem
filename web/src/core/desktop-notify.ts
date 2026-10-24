import type { Translate } from '../i18n';
import { hasFeature, notifyDesktop, onDesktopEvent } from './desktop';

/**
 * Уведомления Windows (R59): кто просится войти, сообщение и упоминание в чате, кто вошёл.
 *
 * Правило одно: уведомлять, когда человек на Cord не смотрит — окно не в фокусе или спрятано в трей
 * (`window.state` оболочки; в браузере — `document.hasFocus()` и видимость вкладки). Пока смотрит,
 * хватает самой страницы: плашки «Запросы на подключение», красного кружка на кнопке чата (R87) и
 * звука. Исключение — упоминание по имени при закрытом чате: оно адресовано лично.
 *
 * Toast всегда тихий (`silent`): звук событию даёт веб (`core/sounds.ts`, переключатель «звуки
 * уведомлений»), и системный звук поверх был бы дублем. `tag` = `room:<id>:<род>` — Windows заменяет
 * прежний toast того же рода, а не копит стопку. «Не беспокоить» соблюдает сама Windows: своей
 * кнопки «не уведомлять» нет (X3).
 */

/** Что знает о себе окно: в фокусе ли и видно ли оно вообще. */
export interface WindowState {
  focused: boolean;
  visible: boolean;
}

export type NotifyEvent =
  /** Просится во встречу; `waiting` — сколько всего ждут у двери. */
  | { kind: 'knock'; name: string; participantId: string; waiting: number }
  | { kind: 'message'; name: string; text: string }
  /** Вошли — именами, склеенными за окно {@link JOIN_WINDOW_MS}. */
  | { kind: 'join'; names: string[] };

export interface NotifyContext extends WindowState {
  roomId: string;
  /** Название встречи — текстом toast'а. */
  title: string;
  chatOpen: boolean;
  /** Своё имя во встрече: по нему узнаётся упоминание. */
  selfName: string;
  /** Может ли этот человек впускать (`participant.approve`). */
  canApprove: boolean;
}

export interface DesktopNotification {
  title: string;
  body: string;
  tag: string;
  silent: true;
  actions?: { id: 'admit' | 'deny'; text: string }[];
  /** Помигать кнопкой на панели задач (`attention`). */
  attention?: true;
}

/** Пределы сообщения `notify` у оболочки (`desktop/src/main/bridge/messages.ts`). */
const TITLE_MAX = 80;
const BODY_MAX = 300;
/** Сколько текста сообщения показать: начало, а не всё письмо. */
const MESSAGE_MAX = 120;
/** Окно склейки входов: пятеро, вошедшие разом, — одно уведомление, а не пять. */
export const JOIN_WINDOW_MS = 3000;

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Сообщение обращается к человеку: `@имя` или имя целым словом, без учёта регистра. */
export function mentions(text: string, name: string): boolean {
  const self = name.trim();
  if (self.length < 2) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escape(self)}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
}

function note(
  title: string,
  body: string,
  tag: string,
  extra: Pick<DesktopNotification, 'actions' | 'attention'> = {},
): DesktopNotification {
  return { title: clip(title, TITLE_MAX), body: clip(body, BODY_MAX), tag, silent: true, ...extra };
}

/** Уведомить ли и чем: `null` — человек и так это видит (или это не его дело). */
export function decideNotification(
  t: Translate,
  event: NotifyEvent,
  context: NotifyContext,
): DesktopNotification | null {
  const watching = context.focused && context.visible;
  const tag = `room:${context.roomId}:${event.kind}`;
  switch (event.kind) {
    case 'knock': {
      if (watching || !context.canApprove) return null;
      if (event.waiting > 1)
        return note(
          t(($) => $.desktop.notify.knockMany, { name: event.name, count: event.waiting - 1 }),
          context.title,
          tag,
          { attention: true },
        );
      return note(
        t(($) => $.desktop.notify.knock, { name: event.name }),
        context.title,
        tag,
        {
          attention: true,
          actions: [
            { id: 'admit', text: t(($) => $.desktop.notify.admit) },
            { id: 'deny', text: t(($) => $.desktop.notify.deny) },
          ],
        },
      );
    }
    case 'message': {
      if (watching && context.chatOpen) return null;
      const personal = mentions(event.text, context.selfName);
      if (watching && !personal) return null;
      const body = clip(event.text, MESSAGE_MAX);
      return personal
        ? note(
            t(($) => $.desktop.notify.mention, { name: event.name }),
            body,
            tag,
            { attention: true },
          )
        : note(event.name, body, tag);
    }
    case 'join': {
      const [first, ...rest] = event.names;
      if (watching || !first) return null;
      return note(
        rest.length
          ? t(($) => $.desktop.notify.joinMany, { name: first, count: rest.length })
          : t(($) => $.desktop.notify.join, { name: first }),
        context.title,
        tag,
      );
    }
  }
}

type Send = (type: string, payload?: Record<string, unknown>) => void;

/**
 * Отправка в оболочку: склейка входов, значок непрочитанных на панели задач и кто просился последним
 * (кнопки «Впустить» и «Отклонить» возвращаются без имени — только с `tag`).
 */
export class DesktopNotifier {
  /** Кто просился войти в последнем уведомлении: его и впускает «Впустить». */
  lastKnock: string | null = null;
  private joins: string[] = [];
  private joinTimer?: ReturnType<typeof setTimeout>;
  private joinContext: (() => NotifyContext) | null = null;
  private badgeCount = 0;

  constructor(
    private readonly t: Translate,
    private readonly send: Send = notifyDesktop,
    private readonly has: (feature: string) => boolean = hasFeature,
  ) {}

  /** Входы ждут окно склейки; контекст берётся в момент отправки — окно могло стать фокусным. */
  notify(event: NotifyEvent, context: NotifyContext | (() => NotifyContext)) {
    if (!this.has('notify')) return;
    const read = typeof context === 'function' ? context : () => context;
    if (event.kind === 'join') {
      this.joins.push(...event.names);
      this.joinContext = read;
      this.joinTimer ??= setTimeout(() => this.flushJoins(), JOIN_WINDOW_MS);
      return;
    }
    const decided = decideNotification(this.t, event, read());
    if (!decided) return;
    if (event.kind === 'knock') this.lastKnock = event.waiting > 1 ? null : event.participantId;
    this.post(decided);
  }

  /** Значок поверх иконки — непрочитанные, пока окно не в фокусе; в фокусе — ноль. */
  badge(unread: number, state: WindowState) {
    if (!this.has('badge')) return;
    const count = state.focused && state.visible ? 0 : unread;
    if (count === this.badgeCount) return;
    this.badgeCount = count;
    this.send('badge', { count });
  }

  dispose() {
    clearTimeout(this.joinTimer);
    this.joinTimer = undefined;
    this.joins = [];
    if (this.badgeCount && this.has('badge')) this.send('badge', { count: 0 });
    this.badgeCount = 0;
  }

  private flushJoins() {
    this.joinTimer = undefined;
    const names = this.joins.splice(0);
    const context = this.joinContext;
    if (!names.length || !context) return;
    const decided = decideNotification(this.t, { kind: 'join', names }, context());
    if (decided) this.post(decided);
  }

  private post({ attention, ...notification }: DesktopNotification) {
    this.send('notify', { ...notification });
    if (attention && this.has('attention')) this.send('attention');
  }
}

/** Окно сейчас: по DOM; оболочка поправит своим `window.state`. */
export function readWindowState(): WindowState {
  return {
    focused: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
    visible: !document.hidden,
  };
}

/**
 * Следить за фокусом и видимостью окна. В клиенте Windows правду говорит оболочка (`window.state`):
 * с `backgroundThrottling: false` страница в трее считает себя видимой. Без оболочки — события окна.
 */
export function watchWindowState(listener: (state: WindowState) => void): () => void {
  let shell: WindowState | null = null;
  const update = () => listener(shell ?? readWindowState());
  const stopShell = onDesktopEvent('window.state', (data) => {
    shell = { focused: data.focused === true, visible: data.visible !== false };
    update();
  });
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  return () => {
    stopShell();
    window.removeEventListener('focus', update);
    window.removeEventListener('blur', update);
    document.removeEventListener('visibilitychange', update);
  };
}
