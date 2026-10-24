import { locale, type Translate } from '../../i18n';

/**
 * Карта настроек: разделы, их группы и подразделы-якоря, строки и поиск по ним (T26).
 *
 * ПОЧЕМУ ВСЁ В ОДНОМ МЕСТЕ. Слева — поиск, разделы и якоря; справа — строки «подпись —
 * действие». Поиск обязан находить ровно те строки, что нарисованы, а якорь — вести туда, где
 * подраздел действительно начинается. Если подписи жили бы в разметке, а поиск — в своём
 * списке, они разошлись бы на первой же правке. Поэтому подпись и пояснение строки берутся
 * отсюда (`rowText`), а разметка разделов только ставит рядом с ними своё управление.
 *
 * Слова — в каталоге (`settings.sections`, `settings.anchors`, `settings.rows`, E14), здесь —
 * только устройство: где какая строка стоит. Ключ строки в каталоге — её `RowId`, и компилятор
 * не даст завести строку без подписи.
 */
export type SectionId =
  | 'profile'
  | 'appearance'
  | 'hotkeys'
  | 'desktop'
  | 'overlay'
  | 'audio'
  | 'video'
  | 'sounds'
  | 'accounts'
  | 'server'
  | 'about';

export type GroupId = 'app' | 'meetings' | 'connections' | 'cord';

export type AnchorId = 'microphone' | 'output' | 'camera' | 'screen';

export interface SectionSpec {
  id: SectionId;
  group: GroupId;
  /** Подразделы — якоря внутри страницы раздела, по порядку. */
  anchors: AnchorId[];
  /** Раздел только для одного места: «Windows» есть лишь в клиенте и лишь со своими строками. */
  only?: RowContext;
  /**
   * Как разложены группы (R18, R101). `cards` (по умолчанию) — карточки, как у Телемоста: короткий
   * раздел помещается в окно без прокрутки. `groups` — заголовки и волоски между группами, как у
   * Discord: для списков (сочетания, переключатели Windows).
   */
  layout?: 'cards' | 'groups';
}

/** Группы разделов по порядку. «О программе» (`cord`) стоит особняком внизу, как у Discord: это не настройка, а справка. */
export const GROUPS: GroupId[] = ['app', 'meetings', 'connections', 'cord'];

export const SECTIONS: SectionSpec[] = [
  { id: 'profile', group: 'app', anchors: [] },
  { id: 'appearance', group: 'app', anchors: [] },
  { id: 'hotkeys', group: 'app', anchors: [], layout: 'groups' },
  { id: 'desktop', group: 'app', anchors: [], only: 'desktop', layout: 'groups' },
  // «Оверлей» (R62, R63) — отдельная страница рядом с «Windows», как «Игровой оверлей» Discord: оверлей,
  // игры, виджет говорящих и его клавиши. Только в клиенте и только со своими флагами оболочки.
  { id: 'overlay', group: 'app', anchors: [], only: 'desktop', layout: 'groups' },
  // «Голос и видео» разделён на два раздела, как у Телемоста (R100): каждый помещается в окно
  // без прокрутки (R101), а превью камеры не включается, пока человек настраивает микрофон.
  { id: 'audio', group: 'meetings', anchors: ['microphone', 'output'] },
  { id: 'video', group: 'meetings', anchors: ['camera', 'screen'] },
  { id: 'sounds', group: 'meetings', anchors: [] },
  { id: 'accounts', group: 'connections', anchors: [] },
  { id: 'server', group: 'connections', anchors: [] },
  { id: 'about', group: 'cord', anchors: [] },
];

export const DEFAULT_SECTION: SectionId = 'audio';

/**
 * Прежние вкладки → новые разделы. Их называют оболочка Windows (`settings.open` с `tab: "audio"`
 * или `"profile"`), ссылка «О программе» на главной и старые закладки; ни одна не должна вести в
 * пустоту.
 */
const LEGACY: Record<string, { section: SectionId; anchor?: AnchorId }> = {
  audio: { section: 'audio', anchor: 'microphone' },
  video: { section: 'video', anchor: 'camera' },
  connection: { section: 'server' },
  theme: { section: 'appearance' },
  // `cord://settings/help` и «Помощь» оболочки: частые вопросы, обращение и знакомство — в «О программе».
  help: { section: 'about' },
};

export interface Place {
  section: SectionId;
  anchor?: AnchorId;
}

/** Куда вести по имени раздела, подраздела или прежней вкладки; незнакомое — раздел по умолчанию. */
export function placeFor(name: string | undefined): Place {
  if (!name) return { section: DEFAULT_SECTION };
  // Своё свойство, а не унаследованное: имя приходит из моста оболочки («constructor» — не вкладка).
  const legacy = Object.hasOwn(LEGACY, name) ? LEGACY[name] : undefined;
  if (legacy) return legacy;
  const [section, anchor] = name.split('#') as [string, string | undefined];
  // Прежний «Голос и видео» (ссылки оболочки и закладки): камера и показ — в «Видео», остальное —
  // в «Микрофон».
  if (section === 'voice') {
    if (anchor === 'camera' || anchor === 'screen') return { section: 'video', anchor };
    if (anchor === 'output') return { section: 'audio', anchor };
    return anchor === 'microphone' || anchor === 'processing'
      ? { section: 'audio', anchor: 'microphone' }
      : { section: 'audio' };
  }
  const spec = SECTIONS.find((candidate) => candidate.id === section);
  if (!spec) return { section: DEFAULT_SECTION };
  const known = spec.anchors.find((a) => a === anchor);
  return known ? { section: spec.id, anchor: known } : { section: spec.id };
}

export function section(id: SectionId): SectionSpec {
  return SECTIONS.find((spec) => spec.id === id) ?? SECTIONS[0]!;
}

/** Название раздела словами. */
export function sectionTitle(t: Translate, id: SectionId): string {
  return t(($) => $.settings.sections[id].title);
}

/** Название группы разделов; у «О программе» его нет. */
export function groupTitle(t: Translate, id: GroupId): string | null {
  return id === 'cord' ? null : t(($) => $.settings.groups[id]);
}

/** Где строка видна: везде, только в браузере или только в приложении для Windows. */
export type RowContext = 'browser' | 'desktop';

export interface RowSpec {
  section: SectionId;
  anchor?: AnchorId;
  only?: RowContext;
  /**
   * Флаг возможности оболочки (мост v2): строка видна, только если оболочка объявила и его, и
   * `app.settings` — переключатель, которого нет в этой сборке или на этой машине, не рисуется.
   */
  feature?: string;
}

/** Есть ли у оболочки возможность — `hasFeature` моста; в тестах и в браузере — никаких. */
export type Has = (feature: string) => boolean;
const NOTHING: Has = () => false;

/** Видна ли строка здесь: место (браузер или клиент) и флаги оболочки. */
export function rowAvailable(spec: RowSpec, context: RowContext, has: Has = NOTHING): boolean {
  if (spec.only && spec.only !== context) return false;
  return !spec.feature || (has('app.settings') && has(spec.feature));
}

/** Виден ли раздел: раздел «только для клиента» — если в нём есть хоть одна видимая строка. */
export function sectionAvailable(id: SectionId, context: RowContext, has: Has = NOTHING): boolean {
  const spec = section(id);
  if (!spec.only) return true;
  if (spec.only !== context) return false;
  return (Object.values(ROWS) as RowSpec[]).some(
    (row) => row.section === id && rowAvailable(row, context, has),
  );
}

/** Разделы, которые здесь есть, по порядку. */
export function sectionsFor(context: RowContext, has: Has = NOTHING): SectionSpec[] {
  return SECTIONS.filter((spec) => sectionAvailable(spec.id, context, has));
}

/**
 * Строки настроек. Пояснение есть только там, где без него ошибаются (T29): подпись, которая
 * объясняет себя сама, пояснения не получает — в каталоге у неё пустое `hint`.
 */
export const ROWS = {
  'profile-name': { section: 'profile' },
  'profile-avatar': { section: 'profile' },
  'appearance-theme': { section: 'appearance' },
  'appearance-language': { section: 'appearance' },
  'hotkey-mic': { section: 'hotkeys' },
  'hotkey-ptt': { section: 'hotkeys', only: 'desktop', feature: 'ptt' },
  'hotkey-other': { section: 'hotkeys' },
  'desktop-tray': { section: 'desktop', only: 'desktop', feature: 'tray' },
  'desktop-thumbar': { section: 'desktop', only: 'desktop', feature: 'thumbar' },
  'desktop-badge': { section: 'desktop', only: 'desktop', feature: 'badge' },
  'desktop-flash': { section: 'desktop', only: 'desktop', feature: 'attention' },
  'desktop-sleep': { section: 'desktop', only: 'desktop', feature: 'sleep' },
  'desktop-mini': { section: 'desktop', only: 'desktop', feature: 'mini' },
  'desktop-autostart': { section: 'desktop', only: 'desktop', feature: 'autostart' },
  'desktop-overlay': { section: 'overlay', only: 'desktop', feature: 'overlay' },
  'desktop-overlay-hotkey': { section: 'overlay', only: 'desktop', feature: 'overlay' },
  'overlay-lock-hotkey': { section: 'overlay', only: 'desktop', feature: 'overlay.widget' },
  'overlay-toast': { section: 'overlay', only: 'desktop', feature: 'golive' },
  'overlay-games': { section: 'overlay', only: 'desktop', feature: 'games' },
  'overlay-corner': { section: 'overlay', only: 'desktop', feature: 'overlay.widget' },
  'overlay-size': { section: 'overlay', only: 'desktop', feature: 'overlay.widget' },
  'overlay-names': { section: 'overlay', only: 'desktop', feature: 'overlay.widget' },
  'overlay-opacity': { section: 'overlay', only: 'desktop', feature: 'overlay.widget' },
  'mic-device': { section: 'audio', anchor: 'microphone' },
  'mic-auto': { section: 'audio', anchor: 'microphone' },
  'mic-volume': { section: 'audio', anchor: 'microphone' },
  noise: { section: 'audio', anchor: 'microphone' },
  echo: { section: 'audio', anchor: 'microphone' },
  'output-device': { section: 'audio', anchor: 'output' },
  'output-volume': { section: 'audio', anchor: 'output' },
  'camera-preview': { section: 'video', anchor: 'camera' },
  'camera-device': { section: 'video', anchor: 'camera' },
  'camera-resolution': { section: 'video', anchor: 'camera' },
  'camera-fps': { section: 'video', anchor: 'camera' },
  'screen-resolution': { section: 'video', anchor: 'screen' },
  'screen-fps': { section: 'video', anchor: 'screen' },
  'screen-preview': { section: 'video', anchor: 'screen' },
  'sounds-on': { section: 'sounds' },
  'sounds-volume': { section: 'sounds' },
  'sounds-samples': { section: 'sounds' },
  'sounds-games': { section: 'sounds' },
  'account-yandex-music': { section: 'accounts' },
  'account-telegram': { section: 'accounts' },
  'server-current': { section: 'server' },
  'server-autoconnect': { section: 'server' },
  'server-password': { section: 'server' },
  'server-ping': { section: 'server' },
  'about-version': { section: 'about' },
  'about-updates': { section: 'about' },
  'about-help': { section: 'about' },
  'about-tour': { section: 'about' },
} satisfies Record<string, RowSpec>;

export type RowId = keyof typeof ROWS;

export function row(id: RowId): RowSpec {
  return ROWS[id];
}

export interface RowText {
  label: string;
  /** Пояснение под подписью или `undefined`, если подпись объясняет себя сама. */
  hint?: string;
  keywords: string;
}

/** Подпись, пояснение и слова для поиска строки — на языке интерфейса. */
export function rowText(t: Translate, id: RowId): RowText {
  const hint = t(($) => $.settings.rows[id].hint);
  return {
    label: t(($) => $.settings.rows[id].label),
    ...(hint ? { hint } : {}),
    keywords: t(($) => $.settings.rows[id].keywords),
  };
}

/** Подпись подраздела или `null`, если якоря у раздела нет. */
export function anchorTitle(t: Translate, sectionId: SectionId, anchor: AnchorId | undefined): string | null {
  if (!anchor || !section(sectionId).anchors.includes(anchor)) return null;
  return t(($) => $.settings.anchors[anchor]);
}

export interface SearchHit {
  /** Строка, если нашлась строка; раздел целиком — без неё. */
  row?: RowId;
  section: SectionId;
  anchor?: AnchorId;
  title: string;
  /** Где это: «Микрофон › Динамики». */
  where: string;
}

/** Нижний регистр и «ё» как «е»: «тёмная» находится по «темная», и наоборот. */
function normalize(text: string, language: string) {
  return text.toLocaleLowerCase(language).replaceAll('ё', 'е');
}

function words(text: string, language: string) {
  return normalize(text, language)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Все слова запроса — начала слов в подписи, ключах и названии раздела. */
function matches(query: string[], haystack: string, language: string) {
  const pool = words(haystack, language);
  return query.every((part) => pool.some((word) => word.startsWith(part)));
}

/**
 * Поиск по настройкам: «эхо», «тёмн», «токен», «горяч» — строки и разделы, где это лежит. Строки,
 * которых в этом месте нет (приложение и браузер), не находятся. Ищет по словам того языка, на
 * котором окно нарисовано.
 */
export function searchSettings(
  t: Translate,
  query: string,
  context: RowContext,
  limit = 8,
  has: Has = NOTHING,
): SearchHit[] {
  const language = locale(t);
  const parts = words(query, language);
  if (!parts.length) return [];
  const hits: SearchHit[] = [];
  for (const spec of sectionsFor(context, has)) {
    const title = sectionTitle(t, spec.id);
    if (matches(parts, `${title} ${t(($) => $.settings.sections[spec.id].keywords)}`, language))
      hits.push({ section: spec.id, title, where: t(($) => $.settings.sectionHit) });
  }
  for (const [id, spec] of Object.entries(ROWS) as [RowId, RowSpec][]) {
    if (!rowAvailable(spec, context, has) || !sectionAvailable(spec.section, context, has)) continue;
    const text = rowText(t, id);
    const home = sectionTitle(t, spec.section);
    const anchor = anchorTitle(t, spec.section, spec.anchor);
    if (!matches(parts, `${text.label} ${text.keywords} ${anchor ?? ''} ${home}`, language)) continue;
    hits.push({
      row: id,
      section: spec.section,
      anchor: spec.anchor,
      title: text.label,
      // Подраздел с именем раздела («Микрофон › Микрофон», R114) не повторяется.
      where: anchor && anchor !== home ? `${home} › ${anchor}` : home,
    });
  }
  return hits.slice(0, limit);
}

/** Якорь подраздела и строки в документе: по нему прокручивают и подсвечивают. */
export const anchorDomId = (anchor: string) => `settings-anchor-${anchor}`;
export const rowDomId = (id: RowId) => `setting-${id}`;
