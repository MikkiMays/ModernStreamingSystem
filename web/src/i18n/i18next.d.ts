import 'i18next';
import type ru from './locales/ru.json';

/**
 * Ключи каталога — из русского исходника. Селекторы (`t(($) => $.language.label)`) проверяются
 * компилятором без тяжёлых шаблонных типов строковых путей: с тысячей с лишним ключей это
 * заметно на времени `tsc`.
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    enableSelector: true;
    resources: { translation: typeof ru };
  }
}
