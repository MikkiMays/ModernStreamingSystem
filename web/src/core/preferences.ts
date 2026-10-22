import { notifyDesktop } from './desktop';
import { defaultScreenMode, type ScreenProfile } from '../media/profiles';
import { cameraLevel, nearestLevel } from '../media/capabilities';
import type { DeviceChoice } from '../media/session';
import { defaultMicHotkey, validHotkey, type Hotkey, type MicHotkeyMode } from './hotkeys';
import { isLanguage, type Language } from '../i18n/languages';

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

/** Игры, у которых есть свои звуки стола (T45). */
export type GameKind = 'poker' | 'durak' | 'chess' | 'gartic';
export const gameKinds: GameKind[] = ['poker', 'durak', 'chess', 'gartic'];

/** Где человек выбирает площадку при входе (T59). */
export type PlatformArea = 'music' | 'cinema';
const platformAreas: PlatformArea[] = ['music', 'cinema'];

export interface Preferences {
  showPing: boolean;
  notificationSounds: boolean;
  /**
   * Громкость сигналов, 0–100: уведомления встречи и звуки игр — одной ручкой (П10). Сто — та
   * громкость, с которой сигналы звучали до появления ручки.
   */
  soundVolume: number;
  /** Звуки столов, у каждой игры свой выключатель. Звучат, только пока включены сигналы. */
  gameSounds: Record<GameKind, boolean>;
  /**
   * Громкость собеседников, 0–100: голоса и боты встречи одной ручкой поверх громкости каждого
   * (её человек ставит в меню участника). Сто — как было до ручки: ничего не убавлено.
   */
  outputVolume: number;
  showIntegrationPanel: boolean;
  yandexMusicToken: string;
  screen: ScreenProfile;
  camera: ScreenProfile;
  devices: DeviceChoice;
  audio: AudioPreferences;
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
  /**
   * Какую площадку выбирали в прошлый раз — у музыки и у кинозала (T59): экран выбора при входе
   * отмечает её и ставит на неё фокус. Своё у устройства, как недавние ссылки. Здесь — только имя:
   * что это за площадка и включена ли она на этом сервере, решает экран выбора, а незнакомое имя
   * (площадку убрали) он просто не отметит.
   */
  lastPlatform: Partial<Record<PlatformArea, string>>;
  name: string;
  /** A small square data URI shown to the room, or an empty string. */
  avatar: string;
  micHotkey: Hotkey | null;
  /**
   * «Нажми и говори» (`hold`) или «включать и выключать» (`toggle`, по умолчанию) — у сочетания
   * микрофона (E01-B3). Удержание действует только в клиенте с Raw Input (флаг `ptt`); в браузере и
   * без модуля сочетание переключает, как раньше, а выбор хранится до следующего раза.
   */
  micHotkeyMode: MicHotkeyMode;
  /**
   * Сочетание оверлея в играх (`overlay.toggle`, клиент на Electron, E01-B2). По умолчанию не
   * назначено: глобальное сочетание отбирается у всех программ, включая игру, — пусть человек
   * выберет его сам.
   */
  overlayHotkey: Hotkey | null;
  /**
   * Что показывать за карточным столом помимо самой игры.
   *
   * Своё у каждого, как громкость: одному нужна подсказка «что у меня собралось», другому она
   * мешает думать; одному лента событий, другому чистый стол. Комната об этом не знает.
   */
  pokerHints: boolean;
  pokerFeed: boolean;
  /**
   * Язык интерфейса (E14), или `null` — как в браузере. Своё у каждого устройства, как тема: один
   * и тот же человек на рабочем компьютере и дома может хотеть разного.
   */
  language: Language | null;
}
const key = 'cord:preferences:v1';
/**
 * Уровень отдачи — всегда выбранный; потолок задаёт сервер (`media/capabilities.ts`), умолчание
 * показа — тоже сервер, у камеры своё — 720p · 30 (`cameraLevel`, R78).
 *
 * Старые записи несут `automatic: true` («Авто» — лестницы больше нет), 1440p (выше нынешнего
 * потолка) и забытые `automaticFps`/режим содержимого. Всё это сводится к ближайшему допустимому
 * уровню при чтении; сама запись не переписывается — другой сервер может разрешать больше.
 *
 * Показ — уровень плюс режим и превью (R95/R80); старые записи без них — «плавность» и превью есть.
 */
function screenPrefs(value: (Partial<ScreenProfile> & { automatic?: unknown }) | undefined): ScreenProfile {
  return {
    ...nearestLevel(value),
    mode: value?.mode === 'sharp' ? 'sharp' : defaultScreenMode,
    preview: value?.preview !== false,
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
    soundVolume:
      typeof data.soundVolume === 'number' && Number.isFinite(data.soundVolume)
        ? Math.max(0, Math.min(100, Math.round(data.soundVolume)))
        : 100,
    gameSounds: Object.fromEntries(
      gameKinds.map((game) => [game, data.gameSounds?.[game] !== false]),
    ) as Record<GameKind, boolean>,
    outputVolume:
      typeof data.outputVolume === 'number' && Number.isFinite(data.outputVolume)
        ? Math.max(0, Math.min(100, Math.round(data.outputVolume)))
        : 100,
    pokerHints: data.pokerHints !== false,
    pokerFeed: data.pokerFeed !== false,
    language: isLanguage(data.language) ? data.language : null,
    showIntegrationPanel: data.showIntegrationPanel !== false,
    yandexMusicToken: typeof data.yandexMusicToken === 'string' ? data.yandexMusicToken : '',
    screen: screenPrefs(data.screen),
    camera: cameraLevel(data.camera),
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
    lastPlatform: Object.fromEntries(
      platformAreas.flatMap((area) => {
        const id: unknown = data.lastPlatform?.[area];
        return typeof id === 'string' && /^[a-z][a-z-]{0,31}$/.test(id) ? [[area, id]] : [];
      }),
    ),
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
    micHotkeyMode: data.micHotkeyMode === 'hold' ? 'hold' : 'toggle',
    overlayHotkey: validHotkey(data.overlayHotkey) ? data.overlayHotkey : null,
  };
}
export function savePreferences(patch: Partial<Preferences>): Preferences {
  const current = readPreferences();
  // Уровень показа приходит и без режима/превью (ряды качества знают только кадр и частоту):
  // то, чего в правке нет, остаётся прежним.
  const next = {
    ...current,
    ...patch,
    ...(patch.screen ? { screen: { ...current.screen, ...patch.screen } } : {}),
  };
  try {
    localStorage.setItem(key, JSON.stringify(next));
    if (patch.name !== undefined) localStorage.setItem('cord:name', patch.name.trim().slice(0, 40));
  } catch {
    /* Still apply for this call. */
  }
  window.dispatchEvent(new Event('cord:preferences'));
  // Оболочке нужны только PING и сигналы — и только когда они поменялись: ползунок громкости
  // иначе слал бы IPC на каждый шаг перетаскивания (R14).
  if (next.showPing !== current.showPing || next.notificationSounds !== current.notificationSounds)
    notifyDesktop('preferences.changed', {
      showPing: next.showPing,
      notificationSounds: next.notificationSounds,
    });
  return next;
}
