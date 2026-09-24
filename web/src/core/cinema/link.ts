import { PROVIDER_IDS, PROVIDERS, type ProviderId } from './providers';
import type { CinemaAt, CinemaItem, CinemaKind, CinemaRoute } from './types';

/**
 * Ссылка в кинозале со стороны браузера.
 *
 * ЧЬЯ ЭТО ССЫЛКА, БРАУЗЕР НЕ РЕШАЕТ. Грамматику адресов каждой площадки знает служба
 * (`Provider.match`): ссылка на ролик YouTube, вставленная в поиск VK, открывается в сцене YouTube,
 * а у ссылки без своей площадки есть общий путь — и всё это одним ответом `POST …/cinema/link`.
 * Разбирай браузер адреса сам, каждая сцена знала бы только свою площадку, и новая форма ссылки
 * ждала бы нового релиза клиента, а не одной правки службы.
 *
 * Здесь — только то, что нужно до вопроса и после ответа: похоже ли набранное на ссылку вообще,
 * какой показать страницу, пока её подробности едут, и что помнить в недавних.
 */

/** Длиннее ссылок служба не принимает (`cinema/address.py`, `LONGEST`). */
export const LONGEST = 2000;
/** Сколько недавних ссылок помнит профиль. */
export const RECENT = 10;

const SCHEME = /^https?:\/\//i;
/** Хост без схемы: `youtu.be`, `m.vkvideo.ru` — с доменом верхнего уровня из букв. */
const BARE_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[:/?#]|$)/i;

/**
 * Похоже ли набранное на ссылку — и какая она со схемой, или `null`.
 *
 * В поиске площадки ссылка — только то, что начинается с `http(s)://` или `www.`: «node.js/express»
 * там — запрос к YouTube, а не адрес. В поле сцены «По ссылке» (`loose`) набирают только ссылки, и
 * там годится и `youtu.be/…` без схемы. Чья это ссылка, решает служба.
 */
export function linkOf(text: string, loose = false): string | null {
  const typed = text.trim();
  if (!typed || typed.length > LONGEST || /\s/.test(typed)) return null;
  const url = SCHEME.test(typed)
    ? typed
    : /^www\./i.test(typed) || (loose && BARE_HOST.test(typed))
      ? `https://${typed}`
      : null;
  if (!url || url.length > LONGEST) return null;
  try {
    return new URL(url).hostname ? url : null;
  } catch {
    return null;
  }
}

/** Площадка из ответа службы — та, которую этот клиент знает: новая служба может знать больше. */
export function knownProvider(id: string): id is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(id);
}

/** Страница сцены по ответу службы. */
export function atOf(route: CinemaRoute): CinemaAt {
  return { page: route.page, kind: route.kind, id: route.id };
}

/**
 * Карточка по ссылке: известны только площадка, вид и номер. Имя, автор и кадр приезжают со
 * страницы ролика (`details`), а если площадка молчит — остаётся это, и «Смотреть вместе» работает
 * всё равно: поток служба разбирает и без каталога площадки.
 */
export function linkCard(provider: ProviderId, at: { kind: CinemaKind; id: string }): CinemaItem {
  const live = at.kind === 'channel';
  return {
    provider,
    kind: at.kind,
    id: at.id,
    title: live ? streamTitle(provider, at.id) : videoTitle(provider),
    author: '',
    channelId: null,
    duration: null,
    live,
    viewers: null,
    views: null,
    poster: null,
  };
}

/** Эфир по имени канала узнают по имени; эфир Rutube — по номеру ролика, и номер ничего не скажет. */
function streamTitle(provider: ProviderId, id: string): string {
  if (provider === 'vk') return `Эфир VK Видео Live: ${id}`;
  if (provider === 'twitch') return `Эфир Twitch: ${id}`;
  return `Эфир ${PROVIDERS[provider].name} по ссылке`;
}

function videoTitle(provider: ProviderId): string {
  if (provider === 'twitch') return 'Запись Twitch по ссылке';
  // «Видео VK», а не «Видео VK Видео».
  return `Видео ${provider === 'vk' ? 'VK' : PROVIDERS[provider].name} по ссылке`;
}

/**
 * Ключ, по которому одна ссылка не встаёт в недавние дважды: хост строчными, без порта по умолчанию
 * и без косой черты в конце пути. Остальное — как есть: у разных параметров и якорей бывают разные
 * страницы.
 */
export function linkKey(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.href;
  } catch {
    return url;
  }
}

/** Недавние ссылки: новая — первой, та же самая — один раз, не больше {@link RECENT}. */
export function rememberLink(recent: readonly string[], url: string): string[] {
  const key = linkKey(url);
  return [url, ...recent.filter((entry) => linkKey(entry) !== key)].slice(0, RECENT);
}

/** Ссылка для глаз: хост отдельно, путь с параметрами отдельно — хост узнают первым. */
export function linkParts(url: string): { host: string; rest: string } {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
    return { host: parsed.host.replace(/^www\./, ''), rest };
  } catch {
    return { host: url, rest: '' };
  }
}
