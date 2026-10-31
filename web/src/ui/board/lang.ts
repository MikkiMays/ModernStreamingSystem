import type { Language } from '../../i18n';

/**
 * Язык Cord → язык Excalidraw (R159). У Excalidraw есть все восемь языков Cord, но под своими кодами:
 * подсказки инструментов, меню и окна редактора говорят на языке человека, а не по-английски.
 */
const CODES: Record<Language, string> = {
  ru: 'ru-RU',
  en: 'en',
  es: 'es-ES',
  fr: 'fr-FR',
  it: 'it-IT',
  'zh-Hans': 'zh-CN',
  de: 'de-DE',
  'pt-BR': 'pt-BR',
};

export function excalidrawLanguage(language: string | undefined): string {
  return CODES[language as Language] ?? 'en';
}
