/**
 * Правила поля чата и вложений (T02) — отдельно от разметки, чтобы проверяться без браузера.
 */

/** До скольких строк поле растёт само; дальше — прокрутка внутри поля. */
export const COMPOSER_MAX_ROWS = 6;

/** Предел файла, пока ядро не ответило своим (`capabilities.fileMaxBytes`, `application.yml`). */
export const DEFAULT_FILE_MAX_BYTES = 100 * 1024 * 1024;

/** Размер по-человечески: КиБ до мебибайта, МиБ до гибибайта, дальше ГиБ. */
export function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${trim(value / 1024 ** 3)} ГиБ`;
  if (value >= 1024 ** 2) return `${trim(value / 1024 ** 2)} МиБ`;
  return `${Math.max(1, Math.ceil(value / 1024))} КиБ`;
}

/** Одна цифра после запятой, и без «,0»: «100 МиБ», а не «100.0 МиБ». */
function trim(value: number): string {
  return (Math.round(value * 10) / 10).toString().replace('.', ',');
}

/**
 * Почему файл не уйдёт — словами, в момент выбора (T02).
 *
 * Подписи «до 100 МиБ» под полем больше нет: она висела всегда и сдвигала кнопку отправки с
 * линии текста, а нужна была ровно один раз — когда файл не помещается. Предел остаётся, и
 * говорится о нём тогда, когда он сработал, а не до того.
 *
 * @returns текст отказа или `null`, если файл помещается.
 */
export function oversize(file: { name: string; size: number }, maxBytes: number): string | null {
  if (file.size <= maxBytes) return null;
  return `«${file.name}» — ${formatBytes(file.size)}. Во встречу можно отправить файл до ${formatBytes(maxBytes)}.`;
}

/**
 * Высота поля сообщения: по содержимому, от одной строки до `maxRows`.
 *
 * Поле растёт вниз-вверх вместе с текстом, а скрепка и «Отправить» остаются на линии его
 * последней строки (`align-items: flex-end` в `meeting-panel.css`). Сверх предела — прокрутка
 * внутри поля, а не панель, уезжающая из-под пальца.
 *
 * @param content `scrollHeight` поля с высотой `auto` — текст вместе с полями.
 * @param line высота строки, px.
 * @param padding сумма верхнего и нижнего поля, px.
 */
export function composerHeight(
  content: number,
  line: number,
  padding: number,
  maxRows = COMPOSER_MAX_ROWS,
): { height: number; scrolls: boolean } {
  const min = line + padding;
  const max = line * maxRows + padding;
  return { height: Math.min(max, Math.max(min, Math.ceil(content))), scrolls: content > max + 0.5 };
}
