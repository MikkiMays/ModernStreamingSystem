import { Clapperboard, Link2, Radio, SquarePlay, Tv, Video, type LucideIcon } from 'lucide-react';
import type { Translate } from '../../i18n';
import type { CinemaProvidersResponse } from './types';

/**
 * Реестр площадок кинозала.
 *
 * ПОЧЕМУ РЕЕСТР, А НЕ РАЗВИЛКИ. Раньше площадку узнавали по строке в доброй паре десятков мест:
 * список в панели интеграций, список в шапке каталога, подписи вкладок канала, цвет иконки —
 * каждое своей копией `'youtube' | 'twitch'`. Пятая площадка правила бы все эти места разом, и
 * какое-нибудь неизбежно забывалось бы. Здесь у площадки одна карточка {@link ProviderSpec}, и
 * новая площадка — это новая запись в {@link PROVIDERS}, а не хирургия по всему кинозалу.
 *
 * ПОЧЕМУ ДВА ЦВЕТА, А НЕ ОДИН. `accent` — цвет вкладки-переключателя площадки в каталоге,
 * `tile` — цвет плитки-выключателя в панели интеграций. У YouTube и Twitch они и раньше не
 * совпадали (`#e33b3b`/`#ff3d3d`, `#8250e6`/`#9147ff`) — два разных места однажды выбрали цвет
 * порознь, и переучивать людей заново не входит в эту задачу. Реестр не стирает расхождение, а
 * просто перестаёт хранить его дважды по всему коду: то же самое хранится один раз. У площадок
 * со своей сценой (Rutube, VK Видео и следующие) вкладки-переключателя нет, и `accent` у них — цвет
 * самой площадки в её сцене: плашка с именем в полосе и выбранный раздел.
 *
 * «По ссылке» — не площадка, а вход для любой ссылки: своя площадка у ссылки есть — она открывается
 * в её сцене, нет — остаётся здесь. Своего цвета у неё нет, и цвет её — общий цвет приложения.
 */
export const PROVIDER_IDS = ['youtube', 'twitch', 'rutube', 'vk', 'ivi', 'link'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * На какой сцене открывается площадка.
 *
 * `'switcher'` — вкладки YouTube и Twitch внутри одного каталога (тот же каталог, что и был).
 * Площадка с другим устройством каталога получает свою сцену: у Rutube это эфиры ТВ, сериалы с
 * сезонами и разделы площадки, у VK Видео — её разделы, сообщества с плейлистами. `'link'` — сцена
 * «По ссылке»: поле для ссылки, недавние ссылки и то, что по ссылке нашлось. Следующие площадки
 * дописывают сюда свои.
 */
export type SceneId = 'switcher' | 'rutube' | 'vk' | 'ivi' | 'link';

/**
 * Карточка площадки — её устройство. Слова о ней (имя по-русски, подсказка, приглашение в поиск) —
 * в каталоге (`cinema.providers.<id>`): {@link providerName}, `t(($) => $.cinema.providers[id].hint)`
 * и `….search`.
 */
export interface ProviderSpec {
  id: ProviderId;
  /** Цвет вкладки-переключателя (`.cinema-service`) — тот же, что задавала CSS раньше; у площадки
   *  со своей сценой — её цвет в этой сцене. Значение CSS: hex площадки или переменная темы. */
  accent: string;
  /** Цвет плитки в панели интеграций (`.service-tile-icon`) — исторически другой оттенок. */
  tile: string;
  icon: LucideIcon;
  scene: SceneId;
}

// Площадки в этой задаче — только включённые в этом релизе; следующие задачи дописывают сюда
// новые записи, а `PROVIDER_IDS` растёт вместе с ними.
export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  youtube: {
    id: 'youtube',
    accent: '#e33b3b',
    tile: '#ff3d3d',
    icon: Tv,
    scene: 'switcher',
  },
  twitch: {
    id: 'twitch',
    accent: '#8250e6',
    tile: '#9147ff',
    icon: Radio,
    scene: 'switcher',
  },
  /*
    Цвет — из их же CSS: `--rt-colors-base-brand-rutube-primary: #1c80e3` в дизайн-токенах сайта
    (`static.rtbcdn.ru/woodpecker/…/web/3680.8cb244615ddfc9f7.css`, правила `[data-themeid=dark]`
    и `[data-themeid=light]`, 24.09.2026). Вкладки-переключателя, с которой исторически разошёлся
    бы цвет плитки, у Rutube нет — поэтому цвет один на обоих местах.
  */
  rutube: {
    id: 'rutube',
    accent: '#1c80e3',
    tile: '#1c80e3',
    icon: SquarePlay,
    scene: 'rutube',
  },
  /*
    Цвет — из их же CSS: `--vkui--vkontakte_color_accent_alternate: #0077ff` в VKUI сайта
    (`st1-24.vkvideo.ru/css/al/vkui.490dad1c.css` и `…/vkvideo-web/entrypoints/core_spa.6b696ae4.css`,
    24.09.2026; там же `--azure_a100: #0077ff` в `base.6a12502f.css`). Вкладки-переключателя у VK,
    как и у Rutube, нет — цвет один на обоих местах.
  */
  vk: {
    id: 'vk',
    accent: '#0077FF',
    tile: '#0077FF',
    icon: Video,
    scene: 'vk',
  },
  /*
    Цвет — из их же CSS: `#ea003d` в `linear-gradient(270deg,#ea003d 0%,#c447ff 100%)`, живом
    бандле сайта (`storm.bundle.0951df.css`, релиз `26.09.10`, проверено 25.09.2026). У ivi нет
    вкладок-переключателя — цвет один на обоих местах, как у Rutube и VK Видео.
  */
  ivi: {
    id: 'ivi',
    accent: '#EA003D',
    tile: '#EA003D',
    icon: Clapperboard,
    scene: 'ivi',
  },
  /*
    Не площадка, а вход для ссылки — и потому нейтральный цвет: общий синий приложения (`--blue`,
    своё значение у светлой и тёмной темы), а не цвет какой-то одной площадки. Плитка — последняя
    в «Кинозале»: сначала площадки, по которым ходят каталогом, потом дверь для всего остального.
  */
  link: {
    id: 'link',
    accent: 'var(--blue)',
    tile: 'var(--blue)',
    icon: Link2,
    scene: 'link',
  },
};

/**
 * Имена площадок, которые пишутся латиницей: так их пишут на любом языке, и в каталог они не идут.
 * У остальных имя по-русски («VK Видео», «По ссылке») — в каталоге: у него есть перевод.
 */
const BRANDS = { youtube: 'YouTube', twitch: 'Twitch', rutube: 'Rutube', ivi: 'ivi' } as const;

/** Имя площадки для глаз. */
export function providerName(t: Translate, id: ProviderId): string {
  if (id === 'vk' || id === 'link') return t(($) => $.cinema.providers[id].name);
  return BRANDS[id];
}

/**
 * Площадки сцены-переключателя, в порядке вкладок.
 *
 * Считается от самого реестра, а не переписывается отдельной строкой: площадка со своей
 * сценой (Rutube, VK Видео, ivi, ссылка) не должна была бы становиться ещё одной вкладкой
 * переключателя только потому, что её забыли вычеркнуть из соседнего списка.
 */
export const SWITCHER_TABS: readonly ProviderId[] = PROVIDER_IDS.filter(
  (id) => PROVIDERS[id].scene === 'switcher',
);

/**
 * Какие площадки показывать — по ответу службы `GET …/cinema/providers`, в порядке реестра.
 *
 * Служба называет только площадки, включённые на этой установке (`CINEMA_PROVIDERS`): выключенной в
 * ответе нет, и каждый вопрос к ней получил бы «Эта площадка выключена на этом сервере». Поэтому с
 * ответом на руках показывается реестр ∩ ответ — а площадку, которую служба знает, а эта сборка нет,
 * показать всё равно нечем. Ответа нет (служба молчит, ещё не ответила или ответила не тем) — весь
 * реестр, как было до этой проверки: сбой одного вопроса не должен запирать весь кинозал.
 */
export function listedProviders(answer: CinemaProvidersResponse | undefined): readonly ProviderId[] {
  if (!Array.isArray(answer?.providers)) return PROVIDER_IDS;
  const listed = new Set<string>(answer.providers.map((entry) => entry.id));
  return PROVIDER_IDS.filter((id) => listed.has(id));
}
