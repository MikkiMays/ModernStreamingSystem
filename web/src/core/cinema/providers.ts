import { Radio, SquarePlay, Tv, type LucideIcon } from 'lucide-react';

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
 * со своей сценой (Rutube и следующие) вкладки-переключателя нет, и `accent` у них — цвет самой
 * площадки в её сцене: плашка с именем в полосе и выбранный раздел.
 */
export const PROVIDER_IDS = ['youtube', 'twitch', 'rutube'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * На какой сцене открывается площадка.
 *
 * `'switcher'` — вкладки YouTube и Twitch внутри одного каталога (тот же каталог, что и был).
 * Площадка с другим устройством каталога получает свою сцену: у Rutube это эфиры ТВ, сериалы с
 * сезонами и разделы площадки. Следующие площадки дописывают сюда свои.
 */
export type SceneId = 'switcher' | 'rutube';

export interface ProviderSpec {
  id: ProviderId;
  name: string;
  hint: string;
  /** Цвет вкладки-переключателя (`.cinema-service`) — тот же, что задавала CSS раньше; у площадки
   *  со своей сценой — её цвет в этой сцене. */
  accent: string;
  /** Цвет плитки в панели интеграций (`.service-tile-icon`) — исторически другой оттенок. */
  tile: string;
  icon: LucideIcon;
  scene: SceneId;
  searchPlaceholder: string;
}

// Площадки в этой задаче — только включённые в этом релизе; следующие задачи дописывают сюда
// новые записи, а `PROVIDER_IDS` растёт вместе с ними.
export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    hint: 'Ролики, фильмы и каналы',
    accent: '#e33b3b',
    tile: '#ff3d3d',
    icon: Tv,
    scene: 'switcher',
    searchPlaceholder: 'Ролик, канал или плейлист',
  },
  twitch: {
    id: 'twitch',
    name: 'Twitch',
    hint: 'Живые эфиры и записи',
    accent: '#8250e6',
    tile: '#9147ff',
    icon: Radio,
    scene: 'switcher',
    searchPlaceholder: 'Канал или игра на Twitch',
  },
  /*
    Цвет — из их же CSS: `--rt-colors-base-brand-rutube-primary: #1c80e3` в дизайн-токенах сайта
    (`static.rtbcdn.ru/woodpecker/…/web/3680.8cb244615ddfc9f7.css`, правила `[data-themeid=dark]`
    и `[data-themeid=light]`, 24.09.2026). Вкладки-переключателя, с которой исторически разошёлся
    бы цвет плитки, у Rutube нет — поэтому цвет один на обоих местах.
  */
  rutube: {
    id: 'rutube',
    name: 'Rutube',
    hint: 'Эфиры ТВ, сериалы и шоу',
    accent: '#1c80e3',
    tile: '#1c80e3',
    icon: SquarePlay,
    scene: 'rutube',
    searchPlaceholder: 'Видео, каналы и ТВ',
  },
};

/**
 * Площадки сцены-переключателя, в порядке вкладок.
 *
 * Считается от самого реестра, а не переписывается отдельной строкой: площадка со своей
 * сценой (библиотека, ссылка) не должна была бы становиться ещё одной вкладкой переключателя
 * только потому, что её забыли вычеркнуть из соседнего списка.
 */
export const SWITCHER_TABS: readonly ProviderId[] = PROVIDER_IDS.filter(
  (id) => PROVIDERS[id].scene === 'switcher',
);
