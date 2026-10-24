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
 * ОДИН ЦВЕТ НА ПЛОЩАДКУ (R33). `accent` — переменная бренда площадки из общего реестра цветов
 * интеграций (`ui/brands.ts`, `--brand-<id>` в `tokens.css`): им красятся вкладка-переключатель в
 * каталоге, плитка в панели интеграций и, у площадок со своей сценой (Rutube, VK Видео и следующие),
 * плашка с именем в полосе и выбранный раздел. Прежде у YouTube и Twitch вкладка и плитка были
 * разных оттенков (`#e33b3b`/`#ff3d3d`, `#8250e6`/`#9147ff`) — владелец попросил отрисовать все
 * интеграции по цветам везде, и цвет стал один.
 *
 * «По ссылке» — не площадка, а вход для любой ссылки: своя площадка у ссылки есть — она открывается
 * в её сцене, нет — остаётся здесь. Цвет её — нейтральный серый, а не цвет какой-то площадки.
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
  /**
   * Цвет площадки — переменная её бренда (`--brand-<id>`, реестр `ui/brands.ts`, R33): им красятся и
   * вкладка переключателя (`.cinema-service`), и плитка в панели интеграций, и её сцена. Раньше у
   * вкладки и плитки были разные оттенки (YouTube `#e33b3b` и `#ff3d3d`) — теперь цвет один на всё.
   */
  accent: string;
  icon: LucideIcon;
  scene: SceneId;
}

// Площадки в этой задаче — только включённые в этом релизе; следующие задачи дописывают сюда
// новые записи, а `PROVIDER_IDS` растёт вместе с ними.
export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  youtube: {
    id: 'youtube',
    accent: 'var(--brand-youtube)',
    icon: Tv,
    scene: 'switcher',
  },
  twitch: {
    id: 'twitch',
    accent: 'var(--brand-twitch)',
    icon: Radio,
    scene: 'switcher',
  },
  /*
    Цвет (`--brand-rutube`) — из их же CSS: `--rt-colors-base-brand-rutube-primary: #1c80e3` в
    дизайн-токенах сайта (`static.rtbcdn.ru/woodpecker/…/web/3680.8cb244615ddfc9f7.css`, правила
    `[data-themeid=dark]` и `[data-themeid=light]`, 24.09.2026).
  */
  rutube: {
    id: 'rutube',
    accent: 'var(--brand-rutube)',
    icon: SquarePlay,
    scene: 'rutube',
  },
  /*
    Цвет (`--brand-vk`) — из их же CSS: `--vkui--vkontakte_color_accent_alternate: #0077ff` в VKUI сайта
    (`st1-24.vkvideo.ru/css/al/vkui.490dad1c.css` и `…/vkvideo-web/entrypoints/core_spa.6b696ae4.css`,
    24.09.2026; там же `--azure_a100: #0077ff` в `base.6a12502f.css`).
  */
  vk: {
    id: 'vk',
    accent: 'var(--brand-vk)',
    icon: Video,
    scene: 'vk',
  },
  /*
    Цвет (`--brand-ivi`) — из их же CSS: `#ea003d` в `linear-gradient(270deg,#ea003d 0%,#c447ff 100%)`,
    живом бандле сайта (`storm.bundle.0951df.css`, релиз `26.09.10`, проверено 25.09.2026).
  */
  ivi: {
    id: 'ivi',
    accent: 'var(--brand-ivi)',
    icon: Clapperboard,
    scene: 'ivi',
  },
  /*
    Не площадка, а вход для ссылки — и потому нейтральный серый (`--brand-link`), а не цвет какой-то
    одной площадки и не цвет приложения. Плитка — последняя в «Кинозале»: сначала площадки, по
    которым ходят каталогом, потом дверь для всего остального.
  */
  link: {
    id: 'link',
    accent: 'var(--brand-link)',
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
