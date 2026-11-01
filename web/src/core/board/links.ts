/**
 * Ссылки на элементах доски (R176): на сайт, почту или телефон — можно, на другой объект доски — нельзя.
 *
 * Ссылка на объект у Excalidraw — адрес этой же страницы с `?element=<id>`: «Скопировать ссылку на
 * объект», «Ссылка на объект» в окне ссылки и вставка такого адреса в поле ссылки. По ней Excalidraw уводил
 * вкладку встречи на тот же адрес (`target="_self"` у ссылок своего сервера) — человек выпадал из встречи.
 */

/** Параметр адреса, которым Excalidraw называет объект (`ELEMENT_LINK_KEY`). */
const ELEMENT_KEY = 'element';
const SCHEME = /^[a-z][a-z\d+.-]*:/i;
/** «example.com», «www.site.ru/page» — адрес сайта без схемы. */
const BARE_HOST = /^[\p{L}\d-]+(\.[\p{L}\d-]+)+(:\d+)?([/?#]\S*)?$/u;

export type LinkTarget =
  /** Сайт, почта или телефон: открыть в новой вкладке по `href`. */
  | { kind: 'web'; href: string }
  /** Внутрь доски — такой ссылки быть не должно. */
  | { kind: 'object' }
  /** Пусто или то, что не открывается (`javascript:`, `data:` …). */
  | { kind: 'none' };

/** Куда ведёт ссылка элемента; `here` — адрес страницы встречи. */
export function linkTarget(link: string | null | undefined, here: string): LinkTarget {
  const value = (link ?? '').trim();
  if (!value) return { kind: 'none' };
  let url: URL;
  try {
    const page = new URL(here);
    if (SCHEME.test(value)) url = new URL(value);
    else if (BARE_HOST.test(value)) url = new URL(`https://${value}`);
    else url = new URL(value, page);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.host === page.host && url.searchParams.has(ELEMENT_KEY)) return { kind: 'object' };
      return { kind: 'web', href: url.href };
    }
  } catch {
    return { kind: 'none' };
  }
  if (url.protocol === 'mailto:' || url.protocol === 'tel:') return { kind: 'web', href: url.href };
  return { kind: 'none' };
}

/** Ссылка ведёт на объект этой доски. */
export function isObjectLink(link: string | null | undefined, here: string): boolean {
  return linkTarget(link, here).kind === 'object';
}
