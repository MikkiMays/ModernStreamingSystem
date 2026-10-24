import { locale, type Translate } from '../i18n';

/**
 * Правила поля чата и вложений (T02) — отдельно от разметки, чтобы проверяться без браузера.
 */

/** До скольких строк поле растёт само; дальше — прокрутка внутри поля. */
export const COMPOSER_MAX_ROWS = 6;

/** Предел файла, пока ядро не ответило своим (`capabilities.fileMaxBytes`, `application.yml`). */
export const DEFAULT_FILE_MAX_BYTES = 100 * 1024 * 1024;

/** Размер по-человечески: КиБ до мебибайта, МиБ до гибибайта, дальше ГиБ. */
export function formatBytes(t: Translate, value: number): string {
  // Одна цифра после запятой, и без «,0»: «100 МиБ», а не «100.0 МиБ». Единиц двоичного размера
  // в `Intl` нет — слово из каталога, число — по языку.
  const number = new Intl.NumberFormat(locale(t), { maximumFractionDigits: 1 });
  if (value >= 1024 ** 3) return t(($) => $.chat.units.gib, { value: number.format(value / 1024 ** 3) });
  if (value >= 1024 ** 2) return t(($) => $.chat.units.mib, { value: number.format(value / 1024 ** 2) });
  return t(($) => $.chat.units.kib, { value: number.format(Math.max(1, Math.ceil(value / 1024))) });
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
export function oversize(
  t: Translate,
  file: { name: string; size: number },
  maxBytes: number,
): string | null {
  if (file.size <= maxBytes) return null;
  return t(($) => $.chat.oversize, {
    name: file.name,
    size: formatBytes(t, file.size),
    max: formatBytes(t, maxBytes),
  });
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

/** Сколько вложений ждут отправки над полем: дальше новые не добавляются. */
export const MAX_PENDING = 10;

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * Картинка из буфера обмена — Ctrl+V скриншота в поле чата (R94); `null` — вставляют текст или
 * в буфере нет картинки, и вставка идёт как обычно.
 *
 * Скриншот браузер отдаёт файлом без имени или с именем «image.png» — у всех одинаковым. В ленте
 * такой файл не отличить от соседнего, поэтому он получает имя по времени снимка:
 * `screenshot-2026-10-24-231502.png`. Своё имя у файла (скопировали файл в проводнике) остаётся.
 */
export function pastedImage(
  data: Pick<DataTransfer, 'files' | 'items' | 'getData'> | null,
  now = new Date(),
): File | null {
  if (!data) return null;
  // Копия из страницы или документа: текст важнее картинки рядом с ним.
  if (data.getData('text/plain').trim()) return null;
  const image = (file: File | null | undefined) => !!file && file.type.startsWith('image/');
  let file = Array.from(data.files ?? []).find(image) ?? null;
  if (!file)
    for (const item of Array.from(data.items ?? [])) {
      const candidate = item.kind === 'file' && item.type.startsWith('image/') ? item.getAsFile() : null;
      if (image(candidate)) {
        file = candidate;
        break;
      }
    }
  if (!file) return null;
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
  const extension = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace(/\+.*$/, '');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return new File([file], `screenshot-${stamp}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}
