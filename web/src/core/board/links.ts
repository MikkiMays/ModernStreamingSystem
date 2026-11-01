/**
 * Ссылки на элементах доски (R176): на сайт или почту — можно, на другой объект доски — нельзя.
 *
 * Ссылка на объект у Excalidraw — адрес этой же страницы с `?element=<id>`: «Скопировать ссылку на
 * объект», «Ссылка на объект» в окне ссылки и вставка такого адреса в поле ссылки. По ней Excalidraw уводил
 * вкладку встречи на тот же адрес (`target="_self"` у ссылок своего сервера) — человек выпадал из встречи.
 *
 * Ядро принимает у элемента только ссылку `https://`, `http://` или `mailto:` (`BoardRoom.safeLink`), а
 * правку с иной отвергает целиком — «example.org», набранный в поле ссылки, раньше так и пропадал у
 * соседей с тостом «Часть правок не поместилась». Поэтому адрес без схемы доска дописывает до https.
 */

/** Параметр адреса, которым Excalidraw называет объект (`ELEMENT_LINK_KEY`). */
const ELEMENT_KEY = 'element';
const SCHEME = /^[a-z][a-z\d+.-]*:/i;
/** Что принимает ядро (`BoardRoom.safeLink`). */
const ACCEPTED = /^(https?:\/\/|mailto:)/i;
const MAX_LINK = 2048;
/** «example.com», «www.site.ru/page» — адрес сайта без схемы. */
const BARE_HOST = /^[\p{L}\d-]+(\.[\p{L}\d-]+)+(:\d+)?([/?#]\S*)?$/u;

export type LinkTarget =
  /** Сайт или почта: открыть в новой вкладке по `href`. */
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
  if (url.protocol === 'mailto:') return { kind: 'web', href: url.href };
  return { kind: 'none' };
}

/** Как поправить ссылку элемента: `link` — новая (`null` — снять), `reason` — почему. */
export interface LinkFix {
  link: string | null;
  reason: 'object' | 'unsupported' | 'normalized';
}

/**
 * Что сделать со ссылкой элемента, чтобы она не вела внутрь доски и ядро её приняло; `null` — ничего:
 * ссылки нет или она и так годна. Сайт без схемы — дописать https; на объект и не сайт — снять.
 */
export function fixLink(link: string | null | undefined, here: string): LinkFix | null {
  if (!link?.trim()) return null;
  // Длиннее ядро не примет (`BoardRoom.safeLink`).
  if (link.length > MAX_LINK) return { link: null, reason: 'unsupported' };
  const target = linkTarget(link, here);
  if (target.kind === 'object') return { link: null, reason: 'object' };
  if (ACCEPTED.test(link.trim())) return null;
  if (target.kind === 'web') return { link: target.href, reason: 'normalized' };
  return { link: null, reason: 'unsupported' };
}
