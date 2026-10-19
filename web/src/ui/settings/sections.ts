/**
 * Карта настроек: разделы, их группы и подразделы-якоря, строки и поиск по ним (T26).
 *
 * ПОЧЕМУ ВСЁ В ОДНОМ МЕСТЕ. Слева — поиск, разделы и якоря; справа — строки «подпись —
 * действие». Поиск обязан находить ровно те строки, что нарисованы, а якорь — вести туда, где
 * подраздел действительно начинается. Если подписи жили бы в разметке, а поиск — в своём
 * списке, они разошлись бы на первой же правке. Поэтому подпись и пояснение строки берутся
 * отсюда (`ROWS`), а разметка разделов только ставит рядом с ними своё управление. Отсюда же их
 * возьмёт слой переводов (E14).
 */
export type SectionId =
  'profile' | 'appearance' | 'hotkeys' | 'voice' | 'sounds' | 'accounts' | 'server' | 'about';

export type GroupId = 'app' | 'meetings' | 'connections' | 'cord';

export interface Anchor {
  id: string;
  title: string;
}

export interface SectionSpec {
  id: SectionId;
  title: string;
  group: GroupId;
  /** Подразделы — якоря внутри страницы раздела, по порядку. */
  anchors: Anchor[];
  /** Чем ещё раздел могут назвать в поиске. */
  keywords?: string;
}

export const GROUPS: { id: GroupId; title: string | null }[] = [
  { id: 'app', title: 'Приложение' },
  { id: 'meetings', title: 'Встречи' },
  { id: 'connections', title: 'Подключения' },
  // «О программе» стоит особняком внизу, как у Discord: это не настройка, а справка.
  { id: 'cord', title: null },
];

export const SECTIONS: SectionSpec[] = [
  { id: 'profile', title: 'Профиль', group: 'app', anchors: [], keywords: 'имя аватар картинка' },
  { id: 'appearance', title: 'Оформление', group: 'app', anchors: [], keywords: 'тема внешний вид' },
  { id: 'hotkeys', title: 'Горячие клавиши', group: 'app', anchors: [], keywords: 'сочетания клавиатура' },
  {
    id: 'voice',
    title: 'Голос и видео',
    group: 'meetings',
    keywords: 'звук микрофон камера',
    anchors: [
      { id: 'microphone', title: 'Микрофон' },
      { id: 'output', title: 'Динамики' },
      { id: 'processing', title: 'Обработка звука' },
      { id: 'camera', title: 'Камера' },
      { id: 'screen', title: 'Демонстрация экрана' },
      { id: 'reception', title: 'Чужое видео' },
      { id: 'advanced', title: 'Дополнительно' },
    ],
  },
  { id: 'sounds', title: 'Звуки', group: 'meetings', anchors: [], keywords: 'уведомления сигналы игры' },
  { id: 'accounts', title: 'Аккаунты', group: 'connections', anchors: [], keywords: 'интеграции сервисы' },
  { id: 'server', title: 'Сервер', group: 'connections', anchors: [], keywords: 'подключение' },
  { id: 'about', title: 'О программе', group: 'cord', anchors: [], keywords: 'версия cord' },
];

export const DEFAULT_SECTION: SectionId = 'voice';

/**
 * Прежние вкладки → новые разделы. Их называют оболочка Windows (`settings.open` с `tab: "audio"`
 * или `"profile"`), ссылка «О программе» на главной и старые закладки; ни одна не должна вести в
 * пустоту.
 */
const LEGACY: Record<string, { section: SectionId; anchor?: string }> = {
  audio: { section: 'voice', anchor: 'microphone' },
  video: { section: 'voice', anchor: 'camera' },
  connection: { section: 'server' },
  theme: { section: 'appearance' },
};

export interface Place {
  section: SectionId;
  anchor?: string;
}

/** Куда вести по имени раздела, подраздела или прежней вкладки; незнакомое — раздел по умолчанию. */
export function placeFor(name: string | undefined): Place {
  if (!name) return { section: DEFAULT_SECTION };
  const legacy = LEGACY[name];
  if (legacy) return legacy;
  const [section, anchor] = name.split('#') as [string, string | undefined];
  const spec = SECTIONS.find((candidate) => candidate.id === section);
  if (!spec) return { section: DEFAULT_SECTION };
  return anchor && spec.anchors.some((a) => a.id === anchor)
    ? { section: spec.id, anchor }
    : { section: spec.id };
}

export function section(id: SectionId): SectionSpec {
  return SECTIONS.find((spec) => spec.id === id) ?? SECTIONS[0]!;
}

/** Где строка видна: везде, только в браузере или только в приложении для Windows. */
export type RowContext = 'browser' | 'desktop';

export interface RowSpec {
  section: SectionId;
  anchor?: string;
  label: string;
  hint?: string;
  keywords?: string;
  only?: RowContext;
}

/**
 * Строки настроек. Пояснение есть только там, где без него ошибаются (T29): подпись, которая
 * объясняет себя сама, пояснения не получает.
 */
export const ROWS = {
  'profile-name': {
    section: 'profile',
    label: 'Имя',
    hint: 'Подставляется при входе во встречу',
    keywords: 'ник никнейм',
  },
  'profile-avatar': {
    section: 'profile',
    label: 'Картинка профиля',
    hint: 'Её видят участники встречи',
    keywords: 'аватар фото аватарка',
  },
  'appearance-theme': {
    section: 'appearance',
    label: 'Тема',
    keywords: 'светлая тёмная тема ночная системная',
  },
  'appearance-bots': {
    section: 'appearance',
    label: 'Боты справа от встречи',
    hint: 'Список активных интеграций рядом со сценой',
    keywords: 'интеграции панель музыка',
  },
  'hotkey-mic': {
    section: 'hotkeys',
    label: 'Микрофон',
    hint: 'Включить или выключить',
    keywords: 'сочетание горячая клавиша mute',
  },
  'hotkey-other': {
    section: 'hotkeys',
    label: 'Клавиши кинозала и игр',
    keywords: 'плеер пауза покер',
  },
  'mic-device': {
    section: 'voice',
    anchor: 'microphone',
    label: 'Устройство ввода',
    keywords: 'микрофон гарнитура',
  },
  'mic-volume': {
    section: 'voice',
    anchor: 'microphone',
    label: 'Громкость микрофона',
    keywords: 'усиление уровень передачи gain',
  },
  'mic-auto': {
    section: 'voice',
    anchor: 'microphone',
    label: 'Подстраивать громкость',
    hint: 'Выравнивает тихий и громкий голос',
    keywords: 'автоматический уровень agc',
  },
  'mic-check': {
    section: 'voice',
    anchor: 'microphone',
    label: 'Проверка микрофона',
    hint: 'Скажите что-нибудь — полоса покажет уровень',
    keywords: 'тест индикатор запись',
  },
  'output-device': {
    section: 'voice',
    anchor: 'output',
    label: 'Устройство вывода',
    keywords: 'динамики наушники колонки вывод звука',
  },
  'output-volume': {
    section: 'voice',
    anchor: 'output',
    label: 'Громкость собеседников',
    keywords: 'вывод голоса звук',
  },
  'output-check': {
    section: 'voice',
    anchor: 'output',
    label: 'Проверка звука',
    keywords: 'тест динамиков',
  },
  noise: {
    section: 'voice',
    anchor: 'processing',
    label: 'Шумоподавление',
    hint: 'Для музыки — «Выключено»',
    keywords: 'шум rnnoise изоляция голоса',
  },
  echo: {
    section: 'voice',
    anchor: 'processing',
    label: 'Эхоподавление',
    hint: 'Нужно, если говорите через динамики',
    keywords: 'эхо',
  },
  'camera-device': {
    section: 'voice',
    anchor: 'camera',
    label: 'Камера',
    keywords: 'веб-камера устройство',
  },
  'camera-resolution': {
    section: 'voice',
    anchor: 'camera',
    label: 'Разрешение камеры',
    keywords: 'качество 720p 1080p',
  },
  'camera-fps': {
    section: 'voice',
    anchor: 'camera',
    label: 'Частота кадров камеры',
    keywords: 'fps плавность',
  },
  'camera-yields': {
    section: 'voice',
    anchor: 'camera',
    label: 'Уступать показу экрана',
    hint: 'Пока идёт ваша демонстрация, камера в 360p',
    keywords: 'демонстрация экономия канал',
  },
  'camera-preview': {
    section: 'voice',
    anchor: 'camera',
    label: 'Предпросмотр',
    hint: 'Видно только вам',
    keywords: 'проверка камеры',
  },
  'screen-resolution': {
    section: 'voice',
    anchor: 'screen',
    label: 'Разрешение показа',
    keywords: 'демонстрация экрана качество стрим',
  },
  'screen-fps': {
    section: 'voice',
    anchor: 'screen',
    label: 'Частота кадров показа',
    keywords: 'демонстрация fps плавность стрим',
  },
  reception: {
    section: 'voice',
    anchor: 'reception',
    label: 'Качество приёма',
    keywords: 'чужое видео трафик',
  },
  playout: {
    section: 'voice',
    anchor: 'advanced',
    label: 'Запас буфера приёма',
    hint: 'Только звук: как он переживает скачки задержки',
    keywords: 'задержка буфер пинг рывки сеть',
  },
  'sounds-on': {
    section: 'sounds',
    label: 'Сигналы встречи',
    hint: 'Вход и выход, просьба войти, чат, микрофон',
    keywords: 'уведомления звуки',
  },
  'sounds-volume': {
    section: 'sounds',
    label: 'Громкость сигналов и игр',
    keywords: 'громкость уведомлений',
  },
  'sounds-samples': {
    section: 'sounds',
    label: 'Прослушать',
    keywords: 'пример сигналов',
  },
  'sounds-games': {
    section: 'sounds',
    label: 'Звуки игр',
    keywords: 'покер дурак шахматы gartic',
  },
  'account-yandex-music': {
    section: 'accounts',
    label: 'Яндекс Музыка',
    keywords: 'токен музыка yandex',
  },
  'account-telegram': {
    section: 'accounts',
    label: 'Telegram',
    keywords: 'телеграм бот',
  },
  'server-current': {
    section: 'server',
    label: 'Сервер',
    keywords: 'адрес отключиться сменить',
  },
  'server-autoconnect': {
    section: 'server',
    label: 'Подключаться при запуске',
    keywords: 'автоподключение',
  },
  'server-password': {
    section: 'server',
    label: 'Сохранённый пароль',
    keywords: 'забыть пароль',
  },
  'server-ping': {
    section: 'server',
    label: 'Показывать PING',
    hint: 'Задержка сервера на главной и во встрече',
    keywords: 'задержка пинг',
  },
  'about-version': {
    section: 'about',
    label: 'Версия',
    keywords: 'номер сборка',
  },
  'about-updates': {
    section: 'about',
    label: 'Обновления',
    keywords: 'проверить обновить скачать windows',
  },
  'about-author': {
    section: 'about',
    label: 'Автор',
    keywords: 'telegram связаться nikgers',
  },
} satisfies Record<string, RowSpec>;

export type RowId = keyof typeof ROWS;

export function row(id: RowId): RowSpec {
  return ROWS[id];
}

/** Подпись подраздела или `null`, если якоря у раздела нет. */
export function anchorTitle(sectionId: SectionId, anchor: string | undefined): string | null {
  if (!anchor) return null;
  return section(sectionId).anchors.find((a) => a.id === anchor)?.title ?? null;
}

export interface SearchHit {
  /** Строка, если нашлась строка; раздел целиком — без неё. */
  row?: RowId;
  section: SectionId;
  anchor?: string;
  title: string;
  /** Где это: «Голос и видео › Микрофон». */
  where: string;
}

/** Нижний регистр и «ё» как «е»: «тёмная» находится по «темная», и наоборот. */
function normalize(text: string) {
  return text.toLocaleLowerCase('ru').replaceAll('ё', 'е');
}

function words(text: string) {
  return normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Все слова запроса — начала слов в подписи, ключах и названии раздела. */
function matches(query: string[], haystack: string) {
  const pool = words(haystack);
  return query.every((part) => pool.some((word) => word.startsWith(part)));
}

/**
 * Поиск по настройкам: «эхо», «тёмн», «токен», «горяч» — строки и разделы, где это лежит. Строки,
 * которых в этом месте нет (приложение и браузер), не находятся.
 */
export function searchSettings(query: string, context: RowContext, limit = 8): SearchHit[] {
  const parts = words(query);
  if (!parts.length) return [];
  const hits: SearchHit[] = [];
  for (const spec of SECTIONS)
    if (matches(parts, `${spec.title} ${spec.keywords ?? ''}`))
      hits.push({ section: spec.id, title: spec.title, where: 'Раздел' });
  for (const [id, spec] of Object.entries(ROWS) as [RowId, RowSpec][]) {
    if (spec.only && spec.only !== context) continue;
    const home = section(spec.section);
    const anchor = anchorTitle(spec.section, spec.anchor);
    if (!matches(parts, `${spec.label} ${spec.keywords ?? ''} ${anchor ?? ''} ${home.title}`)) continue;
    hits.push({
      row: id,
      section: spec.section,
      anchor: spec.anchor,
      title: spec.label,
      where: anchor ? `${home.title} › ${anchor}` : home.title,
    });
  }
  return hits.slice(0, limit);
}

/** Якорь подраздела и строки в документе: по нему прокручивают и подсвечивают. */
export const anchorDomId = (anchor: string) => `settings-anchor-${anchor}`;
export const rowDomId = (id: RowId) => `setting-${id}`;
