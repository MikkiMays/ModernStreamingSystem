import { Cloud, Disc3, FileAudio, SquarePlay } from 'lucide-react';
import { musicSourceName, type MusicSource } from '../core/services';
import type { Translate } from '../i18n';
import type { MusicQuery } from './music-playback';
import type { PlatformTile } from './PlatformPicker';

/**
 * Площадки музыки — то, между чем человек выбирает при входе в «Музыку» (T59, решение владельца В-5).
 *
 * ПОЧЕМУ ВЫБОР, А НЕ ОДНО ПОЛЕ НА ВСЁ. После E06-B название искалось сразу во всех источниках, и
 * ответ приходил тремя группами — YouTube, SoundCloud, Яндекс вперемешку по важности. Владелец
 * попросил, чтобы музыка открывалась так же, как кинозал: сначала площадка, потом поиск и ссылки
 * на ней. Очередь одна на встречу и от площадки не зависит: смена площадки меняет только то, где
 * ищут, — плеер, очередь и бот остаются как были.
 *
 * Какие площадки есть — решает сервер (`MUSIC_SOURCES` → `catalog.sources`); по умолчанию включено
 * всё, YouTube и SoundCloud тоже. Telegram — не площадка выбора: треки из беседы присылает бот, и
 * в панели встречи у него нет ни поиска, ни кнопки (интеграция Telegram — «Скоро», E09).
 */
export type MusicPlatform = Extract<MusicSource, 'youtube' | 'soundcloud' | 'yandex' | 'upload'>;
/** Площадка с полем поиска и ссылок; у «Своих файлов» вместо поля — загрузка. */
export type SearchPlatform = Exclude<MusicPlatform, 'upload'>;

/**
 * Порядок выбора — порядок подсказки витрины (`musicHint`): сначала площадки без аккаунта, которые
 * работают сразу, потом Яндекс (нужен аккаунт комнаты), последними — свои файлы.
 */
export const MUSIC_PLATFORMS: readonly MusicPlatform[] = ['youtube', 'soundcloud', 'yandex', 'upload'];

/**
 * Знак и цвет плитки. Цвета площадок — их собственные (YouTube — тот же, что у плитки кинозала);
 * на жёлтом Яндекса белый знак не читается, поэтому знак тёмный. Свои файлы — цвет приложения:
 * это не чужая площадка, а вход для того, что уже есть у человека.
 */
const LOOK: Record<MusicPlatform, Pick<PlatformTile<MusicPlatform>, 'icon' | 'color' | 'ink'>> = {
  youtube: { icon: SquarePlay, color: '#ff3d3d' },
  soundcloud: { icon: Cloud, color: '#ff5500' },
  yandex: { icon: Disc3, color: '#ffcc00', ink: '#1b1f27' },
  upload: { icon: FileAudio, color: 'var(--accent-fill)' },
};

export function isMusicPlatform(value: unknown): value is MusicPlatform {
  return (MUSIC_PLATFORMS as readonly unknown[]).includes(value);
}

/** Площадки, включённые на этом сервере, — в порядке выбора. */
export function offeredPlatforms(sources: readonly MusicSource[]): MusicPlatform[] {
  return MUSIC_PLATFORMS.filter((id) => sources.includes(id));
}

/**
 * Какая площадка открыта: выбранная, пока сервер её предлагает. `null` — экран выбора: площадку
 * ещё не выбрали, или её выключили на сервере, пока панель была открыта.
 */
export function openPlatform(
  chosen: MusicPlatform | null,
  offered: readonly MusicPlatform[],
): MusicPlatform | null {
  return chosen && offered.includes(chosen) ? chosen : null;
}

/** Какую площадку отметить «Последний выбор»: запомненное имя, если такая площадка сейчас есть. */
export function lastPlatform(
  remembered: string | null,
  offered: readonly MusicPlatform[],
): MusicPlatform | null {
  return isMusicPlatform(remembered) && offered.includes(remembered) ? remembered : null;
}

/** Имя площадки. У загрузки оно своё («Свои файлы»), у трека — «Аудиофайл» (`musicSourceName`). */
export function platformName(t: Translate, id: MusicPlatform): string {
  return id === 'upload' ? t(($) => $.music.platforms.upload.name) : musicSourceName(t, id);
}

/** Плитки и вкладки площадок: имя, строка «что там», знак и цвет. */
export function platformTiles(
  t: Translate,
  offered: readonly MusicPlatform[],
): PlatformTile<MusicPlatform>[] {
  return offered.map((id) => ({
    id,
    name: platformName(t, id),
    note: t(($) => $.music.platforms[id].hint),
    ...LOOK[id],
  }));
}

/**
 * Что делать с набранным в поле площадки.
 *
 * - `search` — слова: поиск только на этой площадке;
 * - `link` — ссылка этой площадки: YouTube и SoundCloud ставят трек в очередь, ссылка Яндекса уходит
 *   в его поиск (там трек проверяется на доступность аккаунту);
 * - `elsewhere` — ссылка другой включённой площадки: её не добавляют молча здесь, а предлагают
 *   перейти туда — иначе «поиск и ссылки только на выбранной площадке» был бы неправдой;
 * - `off` — ссылка площадки, выключенной на этом сервере;
 * - `foreign` — ссылка, которую музыка не открывает вовсе.
 */
export type QueryRoute =
  | { kind: 'empty' }
  | { kind: 'search'; text: string }
  | { kind: 'link'; url: string }
  | { kind: 'elsewhere'; platform: SearchPlatform; url: string }
  | { kind: 'off'; platform: SearchPlatform }
  | { kind: 'foreign' };

export function routeQuery(
  query: MusicQuery,
  platform: SearchPlatform,
  offered: readonly MusicPlatform[],
): QueryRoute {
  switch (query.kind) {
    case 'empty':
    case 'foreign':
      return query;
    case 'text':
      return { kind: 'search', text: query.text };
    case 'link':
      if (query.source === platform) return { kind: 'link', url: query.url };
      return offered.includes(query.source)
        ? { kind: 'elsewhere', platform: query.source, url: query.url }
        : { kind: 'off', platform: query.source };
  }
}
