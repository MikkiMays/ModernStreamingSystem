import { notifyDesktop } from './desktop';
import type { ScreenProfile } from '../media/profiles';
import type { DeviceChoice } from '../media/session';
import type { NetworkMode } from '../media/playout';
import { defaultMicHotkey, validHotkey, type Hotkey } from './hotkeys';

export const networkModes: NetworkMode[] = ['auto', 'low-latency', 'stable'];

/**
 * Как расставить участников.
 *
 * `grid` — все равные; `speaker` — крупно тот, кто говорит (или закреплённый), остальные
 * лентой сбоку. Выбор принадлежит смотрящему, а не комнате: на телефоне в портрете и на
 * мониторе хочется разного, и договариваться об этом с собеседником незачем.
 *
 * Была ещё «Лента» — все один под другим во всю ширину. Она не пережила встречи с сеткой,
 * которая теперь сама считает колонки по размеру сцены: в портрете сетка и так складывается
 * в одну колонку, а на мониторе лента растягивала лица в полосы. Сохранённый выбор «strip»
 * читается как «сетка» — проверка ниже не знает такого значения и берёт значение по умолчанию.
 */
export type StageLayout = 'grid' | 'speaker';
export const stageLayouts: StageLayout[] = ['grid', 'speaker'];

/**
 * Каким присылать чужое видео — решение смотрящего, а не показывающего.
 *
 * `fit` — по размеру плитки: мелкой плитке мелкий поток, развёрнутой — лучший, что есть.
 * `best` — всегда лучший слой, каким бы мелким ни было окно.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ НАСТРОЙКА. Раньше это решалось за человека его же выбором **отдачи**:
 * выставил уровень камеры руками — выключилась и адаптация приёма. Два разных решения были
 * склеены в одно, и ни одно из них нельзя было принять отдельно. Теперь их два.
 */
export type Reception = 'fit' | 'best';
export const receptionModes: Reception[] = ['fit', 'best'];

export interface AudioPreferences {
  suppression: 'off' | 'browser' | 'rnnoise' | 'voice';
  echoCancellation: boolean;
  autoGainControl: boolean;
  gain: number;
}
export const defaultAudio: AudioPreferences = {
  suppression: 'browser',
  echoCancellation: true,
  autoGainControl: true,
  gain: 1,
};

export interface Preferences {
  showPing: boolean;
  notificationSounds: boolean;
  showIntegrationPanel: boolean;
  yandexMusicToken: string;
  screen: ScreenProfile;
  camera: ScreenProfile;
  devices: DeviceChoice;
  audio: AudioPreferences;
  /**
   * Чем жертвовать, когда канал не даёт и непрерывности, и отзывчивости сразу.
   * Влияет только на запас буфера приёма; ни переподключения, ни смены кодеков.
   */
  network: NetworkMode;
  /** Как расставить участников на сцене. Принадлежит смотрящему, а не комнате. */
  layout: StageLayout;
  /**
   * Громкость совместного просмотра, 0–100. Тоже своя у каждого: ролик звучит у всех из своего
   * плеера, и договариваться о громкости не с кем — как и о громкости собеседника.
   */
  watchVolume: number;
  /**
   * Каким языком озвучки и какими субтитрами открывать следующий ролик.
   *
   * Тоже своё: комната смотрит одно кино, но слышать и читать его каждый может по-своему —
   * как и громкость. Пустая озвучка означает «как снял автор»: у ролика с двумя десятками
   * переозвучек это единственный ответ, который не зависит от порядка строк в плейлисте.
   * Пустые субтитры — выключены.
   */
  watchAudio: string;
  watchSubtitles: string;
  /**
   * Недавние ссылки кинозала — последние десять, новая первой.
   *
   * Свои у каждого профиля, как громкость: кто что открывал по ссылке, комнате знать незачем, а
   * вставить ту же ссылку ещё раз — частое дело (серия за серией, эфир после перерыва).
   */
  cinemaLinks: string[];
  /** Каким присылать чужое видео. Тоже принадлежит смотрящему. */
  reception: Reception;
  name: string;
  /** A small square data URI shown to the room, or an empty string. */
  avatar: string;
  micHotkey: Hotkey | null;
  /**
   * Что показывать за карточным столом помимо самой игры.
   *
   * Своё у каждого, как громкость: одному нужна подсказка «что у меня собралось», другому она
   * мешает думать; одному лента событий, другому чистый стол. Комната об этом не знает.
   */
  pokerHints: boolean;
  pokerFeed: boolean;
}
const key = 'cord:preferences:v1';
/**
 * «Авто» — это не уровень, а лестница, и начинается она там же, где лестница в
 * `media/auto-quality.ts`. Камера стояла здесь на 720p30, и это и означало «Авто»: не
 * «столько, сколько тянет связь», а ровно 720p — хуже, чем у любого, кто выбрал уровень
 * руками. Теперь это стартовая ступень, с которой автоматика уходит вверх.
 */
const defaultScreen: ScreenProfile = { resolution: 1080, fps: 30, automatic: true };
const defaultCamera: ScreenProfile = { resolution: 1080, fps: 30, automatic: true };
// Settings saved before the content mode was removed still carry it; the extra key is ignored.
// `automaticFps` тоже остался в старых записях: частота теперь автоматическая ровно тогда,
// когда автоматический сам уровень, и отдельным флагом больше не управляется.
function profile(value: Partial<ScreenProfile> | undefined, fallback: ScreenProfile): ScreenProfile {
  return {
    resolution: [720, 1080, 1440].includes(value?.resolution ?? 0) ? value!.resolution! : fallback.resolution,
    fps: [15, 30, 60].includes(value?.fps ?? 0) ? value!.fps! : fallback.fps,
    automatic: typeof value?.automatic === 'boolean' ? value.automatic : true,
  };
}
export function readPreferences(): Preferences {
  let data: Partial<Preferences> = {};
  try {
    data = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
  } catch {
    /* Use defaults. */
  }
  const devices: DeviceChoice = {};
  for (const kind of ['camera', 'microphone', 'speaker'] as const)
    if (typeof data.devices?.[kind] === 'string') devices[kind] = data.devices[kind];
  return {
    showPing: data.showPing === true,
    notificationSounds: data.notificationSounds !== false,
    pokerHints: data.pokerHints !== false,
    pokerFeed: data.pokerFeed !== false,
    showIntegrationPanel: data.showIntegrationPanel !== false,
    yandexMusicToken: typeof data.yandexMusicToken === 'string' ? data.yandexMusicToken : '',
    screen: profile(data.screen, defaultScreen),
    camera: profile(data.camera, defaultCamera),
    devices,
    audio: {
      suppression: ['off', 'browser', 'rnnoise', 'voice'].includes(data.audio?.suppression ?? '')
        ? data.audio!.suppression
        : 'browser',
      echoCancellation:
        typeof data.audio?.echoCancellation === 'boolean' ? data.audio.echoCancellation : true,
      autoGainControl: typeof data.audio?.autoGainControl === 'boolean' ? data.audio.autoGainControl : true,
      gain:
        typeof data.audio?.gain === 'number' && Number.isFinite(data.audio.gain)
          ? Math.max(0, Math.min(2, data.audio.gain))
          : 1,
    },
    network: networkModes.includes(data.network as NetworkMode) ? data.network! : 'auto',
    reception: receptionModes.includes(data.reception as Reception) ? data.reception! : 'fit',
    layout: stageLayouts.includes(data.layout as StageLayout) ? data.layout! : 'grid',
    watchVolume:
      typeof data.watchVolume === 'number' && Number.isFinite(data.watchVolume)
        ? Math.max(0, Math.min(100, Math.round(data.watchVolume)))
        : 70,
    watchAudio: typeof data.watchAudio === 'string' ? data.watchAudio.slice(0, 24) : '',
    watchSubtitles: typeof data.watchSubtitles === 'string' ? data.watchSubtitles.slice(0, 32) : '',
    cinemaLinks: Array.isArray(data.cinemaLinks)
      ? data.cinemaLinks
          .filter(
            (url): url is string =>
              typeof url === 'string' && url.length <= 2000 && /^https?:\/\//i.test(url),
          )
          .slice(0, 10)
      : [],
    name: (localStorage.getItem('cord:name') ?? (typeof data.name === 'string' ? data.name : '')).slice(
      0,
      40,
    ),
    // The server checks this again before showing it to anyone; this only keeps a corrupt
    // entry from being sent in the first place.
    avatar:
      typeof data.avatar === 'string' && data.avatar.startsWith('data:image/') && data.avatar.length <= 3500
        ? data.avatar
        : '',
    micHotkey:
      data.micHotkey === null ? null : validHotkey(data.micHotkey) ? data.micHotkey : { ...defaultMicHotkey },
  };
}
export function savePreferences(patch: Partial<Preferences>): Preferences {
  const next = { ...readPreferences(), ...patch };
  try {
    localStorage.setItem(key, JSON.stringify(next));
    if (patch.name !== undefined) localStorage.setItem('cord:name', patch.name.trim().slice(0, 40));
  } catch {
    /* Still apply for this call. */
  }
  window.dispatchEvent(new Event('cord:preferences'));
  notifyDesktop('preferences.changed', {
    showPing: next.showPing,
    notificationSounds: next.notificationSounds,
  });
  return next;
}
export function automaticProfile(kind: 'screen' | 'camera'): ScreenProfile {
  return { ...(kind === 'screen' ? defaultScreen : defaultCamera) };
}
