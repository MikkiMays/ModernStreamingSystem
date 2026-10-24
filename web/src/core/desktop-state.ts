import { isLanguage, type Language } from '../i18n/languages';
import type { Meeting } from './meeting';

/**
 * Сообщение `state` оболочке Windows: где человек (главная, предвход, встреча), как его зовут, тема
 * и встреча, если он в ней. `language` — язык интерфейса (R103): на нём оболочка пишет меню трея и
 * свои диалоги. Поле необязательное — оболочка 1.0.5 и раньше его не ждёт и не читает, а незнакомый
 * язык (`resolvedLanguage` до загрузки каталога) не уходит вовсе: оболочка тогда говорит на языке
 * установщика или Windows. Схема — `contracts/desktop-bridge.v2.schema.json`, `$defs/state`.
 */
export type DesktopPageState = {
  page: 'home' | 'prejoin' | 'room';
  inCall: boolean;
  name: string;
  theme: string;
  avatar: string;
  room: { roomId: string; title: string; code: string } | null;
  language?: Language;
};

export function desktopPageState({
  page,
  meeting,
  name,
  theme,
  avatar,
  language,
}: {
  page: DesktopPageState['page'];
  meeting: Meeting | null;
  name: string;
  theme: string;
  avatar: string;
  language: string | undefined;
}): DesktopPageState {
  const inRoom = page === 'room' && !!meeting;
  return {
    page,
    inCall: inRoom && !meeting.ended.get(),
    name,
    theme,
    avatar,
    room: inRoom
      ? {
          roomId: meeting.admission.roomId,
          title: meeting.admission.snapshot.title,
          code: meeting.admission.snapshot.code,
        }
      : null,
    ...(isLanguage(language) ? { language } : {}),
  };
}
