import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n';
import {
  DesktopNotifier,
  decideNotification,
  mentions,
  type NotifyContext,
  type NotifyEvent,
} from './desktop-notify';

/*
  Уведомления Windows (R59): только когда человек не смотрит на Cord — окно не в фокусе или спрятано
  в трей. Звук даёт сам веб (`core/sounds.ts`), поэтому toast всегда тихий: иначе два звука на одно
  событие. Один `tag` на род события — Windows заменяет прежний toast, а не копит стопку.
*/

const away: NotifyContext = {
  roomId: 'room-1',
  title: 'Планёрка',
  focused: false,
  visible: true,
  chatOpen: false,
  selfName: 'Ника',
  canApprove: true,
};
const here: NotifyContext = { ...away, focused: true };
const knock: NotifyEvent = { kind: 'knock', name: 'Аня', participantId: 'ann', waiting: 1 };
const message = (text: string, name = 'Миша'): NotifyEvent => ({ kind: 'message', name, text });

describe('кого и когда уведомлять', () => {
  it('просится войти, окно не в фокусе — имя, «Впустить» и «Отклонить», мигание на панели задач', () => {
    expect(decideNotification(t, knock, away)).toEqual({
      title: 'Аня просится во встречу',
      body: 'Планёрка',
      tag: 'room:room-1:knock',
      silent: true,
      attention: true,
      actions: [
        { id: 'admit', text: 'Впустить' },
        { id: 'deny', text: 'Отклонить' },
      ],
    });
  });

  it('просится войти: в фокусе — плашка веба, без toast; впустить не может — не беспокоим', () => {
    expect(decideNotification(t, knock, here)).toBeNull();
    expect(decideNotification(t, knock, { ...away, canApprove: false })).toBeNull();
  });

  it('просятся несколько — «и ещё N», без кнопок: впускают из списка людей', () => {
    const many = decideNotification(t, { ...knock, waiting: 3 }, away)!;
    expect(many.title).toBe('Аня и ещё 2 просятся во встречу');
    expect(many.actions).toBeUndefined();
  });

  it('окно спрятано в трей — это «не смотрит», даже если фокус формально у него', () => {
    expect(decideNotification(t, knock, { ...here, visible: false })).not.toBeNull();
  });

  it('сообщение без фокуса — имя и начало текста, не длиннее 120 знаков', () => {
    const long = 'а'.repeat(200);
    const note = decideNotification(t, message(long), away)!;
    expect(note).toMatchObject({ title: 'Миша', tag: 'room:room-1:message', silent: true });
    expect(note.body).toHaveLength(120);
    expect(note.body.endsWith('…')).toBe(true);
    expect(note.attention).toBeUndefined();
  });

  it('сообщение в фокусе: чат закрыт — красный кружок на кнопке чата вместо toast; открыт — ничего', () => {
    expect(decideNotification(t, message('привет'), here)).toBeNull();
    expect(decideNotification(t, message('привет'), { ...here, chatOpen: true })).toBeNull();
  });

  it('упоминание — и в фокусе при закрытом чате, с миганием; открыт и в фокусе — уже видно', () => {
    const note = decideNotification(t, message('@Ника глянь экран'), here)!;
    expect(note).toMatchObject({ title: 'Миша упоминает вас', attention: true });
    expect(decideNotification(t, message('Ника, ты тут?'), { ...here, chatOpen: true })).toBeNull();
  });

  it('упоминание — по @имени или имени целым словом, без учёта регистра', () => {
    expect(mentions('@ника привет', 'Ника')).toBe(true);
    expect(mentions('Привет, Ника!', 'Ника')).toBe(true);
    expect(mentions('Никакой экран', 'Ника')).toBe(false);
    expect(mentions('ok', 'А')).toBe(false);
  });

  it('вошёл — только без фокуса; несколько за раз — одной строкой', () => {
    expect(decideNotification(t, { kind: 'join', names: ['Аня'] }, here)).toBeNull();
    expect(decideNotification(t, { kind: 'join', names: ['Аня'] }, away)).toMatchObject({
      title: 'Аня во встрече',
      body: 'Планёрка',
      tag: 'room:room-1:join',
    });
    expect(decideNotification(t, { kind: 'join', names: ['Аня', 'Миша', 'Оля'] }, away)!.title).toBe(
      'Аня и ещё 2 во встрече',
    );
  });

  it('пределы оболочки: заголовок ≤ 80, текст ≤ 300', () => {
    const note = decideNotification(
      t,
      { ...knock, name: 'Я'.repeat(100) },
      { ...away, title: 'T'.repeat(400) },
    )!;
    expect(note.title.length).toBeLessThanOrEqual(80);
    expect(note.body.length).toBeLessThanOrEqual(300);
  });
});

describe('DesktopNotifier', () => {
  const send = vi.fn();
  let notifier: DesktopNotifier;
  beforeEach(() => {
    vi.useFakeTimers();
    send.mockReset();
    notifier = new DesktopNotifier(t, send, () => true);
  });
  afterEach(() => {
    notifier.dispose();
    vi.useRealTimers();
  });

  it('входы за 3 с склеиваются в одно уведомление', () => {
    notifier.notify({ kind: 'join', names: ['Аня'] }, away);
    notifier.notify({ kind: 'join', names: ['Миша'] }, away);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('notify', expect.objectContaining({ title: 'Аня и ещё 1 во встрече' }));
  });

  it('просьба войти — сразу, и мигание панели задач отдельным сообщением', () => {
    notifier.notify(knock, away);
    expect(send.mock.calls.map(([type]) => type)).toEqual(['notify', 'attention']);
    expect(send.mock.calls[0]![1]).not.toHaveProperty('attention');
    expect(notifier.lastKnock).toBe('ann');
  });

  it('оболочка без уведомлений — ничего не шлём', () => {
    const quiet = new DesktopNotifier(t, send, () => false);
    quiet.notify(knock, away);
    expect(send).not.toHaveBeenCalled();
  });
});
