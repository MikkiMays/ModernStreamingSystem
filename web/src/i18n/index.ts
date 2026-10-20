import i18next from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';
import ru from './locales/ru.json';

/**
 * Языки Cord (П9). Русский — исходный и встроен в сборку; остальные приходят отдельным файлом,
 * когда их выбрали, — первый экран не платит за семь чужих каталогов.
 */
export const LANGUAGES = ['ru', 'en', 'es', 'fr', 'it', 'zh-Hans', 'de', 'pt-BR'] as const;
export type Language = (typeof LANGUAGES)[number];
export const SOURCE_LANGUAGE: Language = 'ru';

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

const STORAGE = 'cord:language';

/** Код языка браузера → язык Cord: точное совпадение, затем по основе (`zh-CN` → `zh-Hans`). */
export function matchLanguage(tag: string | undefined): Language | null {
  if (!tag) return null;
  const exact = LANGUAGES.find((language) => language.toLowerCase() === tag.toLowerCase());
  if (exact) return exact;
  const base = tag.toLowerCase().split('-')[0];
  if (base === 'zh') return 'zh-Hans';
  if (base === 'pt') return 'pt-BR';
  return LANGUAGES.find((language) => language.toLowerCase() === base) ?? null;
}

function savedLanguage(): Language | null {
  try {
    return matchLanguage(localStorage.getItem(STORAGE) ?? undefined);
  } catch {
    return null;
  }
}

/** Выбор человека важнее языка браузера; без обоих — русский. */
export function detectLanguage(
  saved = savedLanguage(),
  browser: readonly string[] = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language],
): Language {
  if (saved) return saved;
  for (const tag of browser) {
    const match = matchLanguage(tag);
    if (match) return match;
  }
  return SOURCE_LANGUAGE;
}

void i18next
  .use(initReactI18next)
  .use(resourcesToBackend((language: string) => import(`./locales/${language}.json`)))
  .init({
    lng: detectLanguage(),
    fallbackLng: SOURCE_LANGUAGE,
    supportedLngs: [...LANGUAGES],
    resources: { ru: { translation: ru } },
    partialBundledLanguages: true,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
document.documentElement.lang = i18next.language;

/** Сменить язык и запомнить выбор на этом устройстве (`null` — снова «как в браузере»). */
export async function setLanguage(language: Language | null) {
  try {
    if (language) localStorage.setItem(STORAGE, language);
    else localStorage.removeItem(STORAGE);
  } catch {
    /* Без хранилища выбор просто не переживёт перезагрузку. */
  }
  const next = language ?? detectLanguage(null);
  await i18next.changeLanguage(next);
  document.documentElement.lang = next;
}

/**
 * Текст ошибки сервера на языке человека. По-русски ядро и служба уже сказали точно, с числами и
 * именами, — это и показываем; на другом языке — перевод по стабильному коду из реестра
 * (`contracts/errors.json`), а если его нет — всё тот же текст сервера.
 */
export function errorText(code: string, detail: string): string {
  if (i18next.language === SOURCE_LANGUAGE) return detail;
  const key = `errors.${code}`;
  return i18next.exists(key) ? i18next.t(key) : detail;
}

export { i18next };
