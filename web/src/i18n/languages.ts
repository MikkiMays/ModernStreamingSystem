/**
 * Языки Cord (П9) и выбор между ними — без самой библиотеки переводов: этим пользуются и
 * предпочтения (`core/preferences.ts`), и слой переводов, а предпочтения не должны тянуть за собой
 * каталог.
 */
export const LANGUAGES = ['ru', 'en', 'es', 'fr', 'it', 'zh-Hans', 'de', 'pt-BR'] as const;
export type Language = (typeof LANGUAGES)[number];
export const SOURCE_LANGUAGE: Language = 'ru';
/**
 * Языки с переведённым каталогом. Язык браузера выбирается только из них: каталог-заглушка — это
 * русский текст под `locale`, `<html lang>` и правилами чисел чужого языка («Субтитры Russian»,
 * английские формы при числах у русских строк). Язык попадает сюда, только когда у него ноль замечаний
 * у `scripts/i18n/coverage.mjs` (E14-B): каждый ключ ru есть, вставки и разметка те же, формы числа —
 * свои. CI держит это и дальше: новый ключ ru без переводов роняет проверку.
 * Явный выбор в «Оформлении» — любой из `LANGUAGES`.
 */
export const TRANSLATED: readonly Language[] = ['ru', 'en', 'es', 'fr', 'it', 'zh-Hans', 'de', 'pt-BR'];

/** Как каждый язык называет себя сам — так его и ищут в списке. */
export const LANGUAGE_NAMES: Record<Language, string> = {
  ru: 'Русский',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  'zh-Hans': '简体中文',
  de: 'Deutsch',
  'pt-BR': 'Português (Brasil)',
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/** Код языка браузера → язык Cord: точное совпадение, затем по основе (`zh-CN` → `zh-Hans`). */
export function matchLanguage(tag: string | undefined | null): Language | null {
  if (!tag) return null;
  const exact = LANGUAGES.find((language) => language.toLowerCase() === tag.toLowerCase());
  if (exact) return exact;
  const base = tag.toLowerCase().split('-')[0];
  if (base === 'zh') return 'zh-Hans';
  if (base === 'pt') return 'pt-BR';
  return LANGUAGES.find((language) => language.toLowerCase() === base) ?? null;
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

/** Выбор человека важнее языка браузера (если на него уже переведено, `TRANSLATED`); без обоих — русский. */
export function detectLanguage(
  saved: Language | null,
  browser: readonly string[] = browserLanguages(),
): Language {
  if (saved) return saved;
  for (const tag of browser) {
    const match = matchLanguage(tag);
    if (match && TRANSLATED.includes(match)) return match;
  }
  return SOURCE_LANGUAGE;
}
