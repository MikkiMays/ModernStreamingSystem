import i18next, { type TFunction } from 'i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { initReactI18next } from 'react-i18next';
import ru from './locales/ru.json';
import { detectLanguage, LANGUAGES, SOURCE_LANGUAGE, type Language } from './languages';

export * from './languages';

/**
 * Слой переводов (E14-A).
 *
 * Русский — исходный и встроен в сборку: он же запасной для любого ключа, которого в другом языке
 * ещё нет. Остальные языки приходят отдельными файлами сборки, когда их выбрали, — первый экран не
 * платит за семь чужих каталогов.
 *
 * Ключи — селекторами: `t(($) => $.settings.title)`. Их проверяет компилятор, а лишних шаблонных
 * типов строковых путей на тысячу с лишним ключей `tsc` не считает (`i18next.d.ts`).
 */
const catalogs = import.meta.glob<{ default: Record<string, unknown> }>([
  './locales/*.json',
  '!./locales/ru.json',
]);

void i18next
  .use(initReactI18next)
  .use(
    resourcesToBackend((language: string) => {
      const load = catalogs[`./locales/${language}.json`];
      return load ? load().then((module) => module.default) : Promise.resolve({});
    }),
  )
  .init({
    // Сразу и синхронно — по-русски: модуль, который спросит перевод при загрузке, получит текст, а
    // не ключ. Язык человека ставит `applyLanguage` до первой отрисовки (`main.tsx`).
    lng: SOURCE_LANGUAGE,
    fallbackLng: SOURCE_LANGUAGE,
    supportedLngs: [...LANGUAGES],
    load: 'currentOnly',
    resources: { ru: { translation: ru } },
    partialBundledLanguages: true,
    initAsync: false,
    enableSelector: true,
    interpolation: { escapeValue: false },
    returnNull: false,
    // Язык меняется уже загруженным (`applyLanguage` ждёт файл), так что ждать в Suspense нечего.
    react: { useSuspense: false },
  });

i18next.on('languageChanged', (language) => {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
});

/**
 * Перевод вне компонента. Компонент берёт свой `t` из `useTranslation()`: тот меняется вместе с
 * языком, и React Compiler пересчитывает всё, что от него зависит.
 */
export type Translate = TFunction<'translation'>;
export const t: Translate = i18next.t;

/**
 * Поставить язык: сохранённый выбор, иначе язык браузера, иначе русский. Ждёт файл каталога, чтобы
 * интерфейс не мигнул русским; файл не загрузился — остаётся русский, и это не ошибка.
 */
export async function applyLanguage(saved: Language | null): Promise<Language> {
  const language = detectLanguage(saved);
  await i18next.changeLanguage(language).catch(() => undefined);
  // Язык, на котором интерфейс нарисован сейчас: следующий выбор мог успеть раньше этого файла.
  document.documentElement.lang = i18next.language;
  return language;
}

/**
 * Языковой тег для `Intl` — даты, время, числа и размеры. Из каталога, а не из кода языка: какой
 * вид чисел у языка, решает его каталог. Функции, которые форматируют для разметки, берут `t`
 * компонента — тогда смена языка пересчитывает и их.
 */
export function locale(translate: Translate = t): string {
  return translate(($) => $.locale);
}

/**
 * Текст ошибки сервера на языке человека. По-русски ядро уже сказало точно, с числами и именами, —
 * это и показываем; на другом языке — перевод по стабильному коду из реестра
 * (`contracts/errors.json`), а если в этом языке его ещё нет — всё тот же текст сервера.
 */
export function errorText(code: string | undefined, detail: string): string {
  const language = i18next.language;
  if (!code || !language || language === SOURCE_LANGUAGE) return detail;
  const text: unknown = i18next.getResource(language, 'translation', `errors.${code}`);
  return typeof text === 'string' && text ? text : detail;
}

export { i18next };
