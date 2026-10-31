import type { Admission } from '../api/types';

/**
 * Ссылка на новую встречу — в буфер сразу при создании (R142, «ВАЖНО» владельца 31.10).
 *
 * Буфер браузеры дают писать только в самом нажатии, а ссылку сервер вернёт позже. Поэтому запись
 * начинается в нажатии «Начать встречу», а текст подставляется, когда встреча создана: `ClipboardItem`
 * принимает обещание (Safari иначе не пишет вовсе, Chromium и клиент Windows — тоже так умеют).
 * Где обещание не берут — запасной путь `writeText`, когда ссылка уже есть: Chromium пишет из
 * страницы в фокусе и без жеста.
 *
 * Итог ждёт встреча: `takeInviteCopy` отдаёт его один раз — первой открывшейся встрече, не позже
 * минуты, — и та показывает тост «Ссылка на встречу скопирована» или, если буфер не дался, тост с
 * кнопкой «Скопировать» (её нажатие — жест, и тогда запись проходит везде).
 */
export interface InviteCopy {
  /** Ссылка новой встречи или `null`, если создать её не вышло. */
  link: Promise<string | null>;
  /** Легла ли ссылка в буфер. */
  copied: Promise<boolean>;
}

/** Ссылка-приглашение, как её показывает «Пригласить»: своя ссылка встречи или вход по коду. */
export function inviteLink(admission: Pick<Admission, 'inviteUrl' | 'snapshot'>): string | null {
  if (admission.inviteUrl) return admission.inviteUrl;
  const code = admission.snapshot?.code;
  return code ? `${location.origin}/join/${code}` : null;
}

/** Записать в буфер текст, который придёт позже; `false` — не вышло или текста нет. */
export async function copyWhenReady(text: Promise<string | null>): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard) return false;
  if (typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
    const blob = text.then((value) => {
      if (!value) throw new Error('no link');
      return new Blob([value], { type: 'text/plain' });
    });
    // Отказ создания ловит и запасной путь ниже; здесь — только чтобы он не всплыл необработанным.
    blob.catch(() => {});
    try {
      await clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    } catch {
      // Обещание в `ClipboardItem` не берут или запись отклонена — пробуем текстом.
    }
  }
  try {
    const value = await text;
    if (!value) return false;
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

let pending: (InviteCopy & { at: number }) | null = null;
const FRESH_MS = 60_000;

/** Начать копирование в нажатии «Начать встречу»; `link` разрешается ссылкой созданной встречи. */
export function startInviteCopy(link: Promise<string | null>): InviteCopy {
  const copy = { link, copied: copyWhenReady(link) };
  pending = { ...copy, at: Date.now() };
  return copy;
}

/**
 * Начать копирование ссылки встречи, которой ещё нет: вернёт, чем подставить ссылку, когда сервер
 * её даст (или `null`, если создать встречу не вышло).
 */
export function beginInviteCopy(): (link: string | null) => void {
  let resolve!: (link: string | null) => void;
  startInviteCopy(new Promise<string | null>((done) => (resolve = done)));
  return resolve;
}

/** Забрать итог для открывшейся встречи — один раз; старше минуты — уже не про эту встречу. */
export function takeInviteCopy(now = Date.now()): InviteCopy | null {
  const copy = pending;
  pending = null;
  return copy && now - copy.at <= FRESH_MS ? copy : null;
}
