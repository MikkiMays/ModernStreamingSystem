// Страница → SVG со слоями для Figma (E15-B, T57). Функции выполняются в браузере (`page.evaluate`),
// поэтому всё — внутри них, без замыканий на модуль.
//
// Figma превращает SVG в редактируемые слои: <g id> — группа с этим именем, <text> — текст, фигуры —
// векторы, <image> — прямоугольник с картинкой, фильтр тени в виде, который выгружает сама Figma, —
// эффект «тень». Чего импорт не переносит (насыщенность шрифта, межбуквенный интервал), то записано в
// имени слоя меткой `⟦…⟧`: её читает и снимает дообработка в Figma (`figma-layers.mjs`).
//
// Дерево: видимые элементы в порядке отрисовки (братья — по z-index), фон и рамка — прямоугольник
// (радиусы, градиенты, картинка фона), тени — фильтр, `overflow` ≠ visible — обрезка детей, повёрнутые
// элементы — матрицей вокруг transform-origin (меряются без поворота), значки SVG — своими путями с
// вычисленными цветами, картинки/видео/холсты — растром в data-URL, текст — по строкам, как их
// разложил браузер.

export async function domToSvg({ fullPage = true, maxImage = 1600 } = {}) {
  const de = document.documentElement;
  const W = de.clientWidth;
  const H = fullPage ? Math.max(de.scrollHeight, innerHeight) : innerHeight;
  const ox = fullPage ? scrollX : 0;
  const oy = fullPage ? scrollY : 0;
  const defs = [];
  let uid = 0;
  let count = 0;
  const id = (p) => `${p}${++uid}`;
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const n = (v) => Math.round(v * 100) / 100;
  /** Список CSS через запятую верхнего уровня (запятые внутри скобок не делят). */
  const splitTop = (str) => {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of str) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const cctx = document.createElement('canvas').getContext('2d');

  /** Любой цвет CSS → {hex, a}; холст нормализует запись сам. */
  function color(c, keep = false) {
    if (!c || c === 'none' || (c === 'transparent' && !keep)) return null;
    const m0 = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c);
    if (m0) {
      const [r, g, b] = [m0[1], m0[2], m0[3]].map((v) => Math.round(Number(v) * 255));
      const a = m0[4] === undefined ? 1 : Number(m0[4]);
      if (a === 0 && !keep) return null;
      return { hex: '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join(''), a };
    }
    cctx.fillStyle = '#000';
    cctx.fillStyle = c;
    const v = cctx.fillStyle;
    if (v[0] === '#') return { hex: v, a: 1 };
    const m = /rgba?\(([^)]+)\)/.exec(v);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    const a = p[3] ?? 1;
    if (a === 0 && !keep) return null;
    return {
      hex:
        '#' +
        p
          .slice(0, 3)
          .map((x) => Math.round(x).toString(16).padStart(2, '0'))
          .join(''),
      a,
    };
  }
  // Импорт Figma теряет stroke-opacity, поэтому прозрачность обводки — прозрачностью фигуры (обводки
  // рисуются только у фигур без заливки); дообработка переносит её обратно в краску.
  const paint = (attr, c) =>
    c
      ? ` ${attr}="${c.hex}"${c.a < 1 ? (attr === 'stroke' ? ` opacity="${n(c.a)}"` : ` ${attr}-opacity="${n(c.a)}"`) : ''}`
      : ` ${attr}="none"`;

  /** Радиусы углов в px (проценты — от ширины и высоты), урезанные, как это делает браузер. */
  function radii(cs, w, h) {
    const one = (v, horizontal) => {
      const parts = v.split(' ');
      const val = (s, d) => (s.endsWith('%') ? (parseFloat(s) / 100) * d : parseFloat(s) || 0);
      return horizontal ? val(parts[0], w) : val(parts[1] ?? parts[0], h);
    };
    let r = [
      cs.borderTopLeftRadius,
      cs.borderTopRightRadius,
      cs.borderBottomRightRadius,
      cs.borderBottomLeftRadius,
    ].map((v) => Math.min(one(v, true), one(v, false)));
    const f = Math.min(
      1,
      w / (r[0] + r[1] || 1),
      w / (r[2] + r[3] || 1),
      h / (r[0] + r[3] || 1),
      h / (r[1] + r[2] || 1),
    );
    if (f < 1) r = r.map((v) => v * f);
    return r;
  }
  /** Форма с радиусами: <rect rx> при равных углах, иначе путь. */
  function shape(x, y, w, h, r, extra = '') {
    if (r.every((v) => Math.abs(v - r[0]) < 0.01))
      return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${r[0] > 0 ? ` rx="${n(r[0])}"` : ''}${extra}/>`;
    const [a, b, c, d] = r;
    const p = `M${n(x + a)} ${n(y)}H${n(x + w - b)}${b ? `A${n(b)} ${n(b)} 0 0 1 ${n(x + w)} ${n(y + b)}` : ''}V${n(y + h - c)}${
      c ? `A${n(c)} ${n(c)} 0 0 1 ${n(x + w - c)} ${n(y + h)}` : ''
    }H${n(x + d)}${d ? `A${n(d)} ${n(d)} 0 0 1 ${n(x)} ${n(y + h - d)}` : ''}V${n(y + a)}${a ? `A${n(a)} ${n(a)} 0 0 1 ${n(x + a)} ${n(y)}` : ''}Z`;
    return `<path d="${p}"${extra}/>`;
  }

  /** Тени из box-shadow (внешние) → фильтр в записи Figma; кольцо без размытия — обводкой. */
  function shadows(cs) {
    if (!cs.boxShadow || cs.boxShadow === 'none') return { filter: null, rings: [], insets: [] };
    const list = splitTop(cs.boxShadow);
    const drops = [];
    const rings = [];
    const insets = [];
    for (const s of list) {
      const inset = /\binset\b/.test(s);
      const cm = /(rgba?\([^)]*\)|#[0-9a-f]+|color\([^)]*\))/i.exec(s);
      const c = color(cm ? cm[1] : 'rgba(0,0,0,0.3)');
      if (!c) continue;
      const nums =
        s
          .replace(cm ? cm[1] : '', '')
          .replace('inset', '')
          .match(/-?[\d.]+px|-?[\d.]+(?=\s|$)/g)
          ?.map(parseFloat) ?? [];
      const [dx = 0, dy = 0, blur = 0, spread = 0] = nums;
      // Внутренние тени без размытия — это рамки и полоски (набор E16 рисует ими границы полей).
      if (inset) {
        if (!blur) insets.push({ c, dx, dy, spread });
        continue;
      }
      if (!blur && !dx && !dy && spread) rings.push({ c, spread });
      else drops.push({ c, dx, dy, blur, spread });
    }
    if (!drops.length) return { filter: null, rings, insets };
    const fid = id('f');
    let body = '<feFlood flood-opacity="0" result="BackgroundImageFix"/>';
    let prev = 'BackgroundImageFix';
    drops.forEach((d, i) => {
      body +=
        `<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>` +
        (d.spread > 0
          ? `<feMorphology radius="${n(d.spread)}" operator="dilate" in="SourceAlpha" result="effect${i + 1}_dropShadow"/>`
          : '') +
        (d.spread < 0
          ? `<feMorphology radius="${n(-d.spread)}" operator="erode" in="SourceAlpha" result="effect${i + 1}_dropShadow"/>`
          : '') +
        `<feOffset dx="${n(d.dx)}" dy="${n(d.dy)}"/>` +
        `<feGaussianBlur stdDeviation="${n(d.blur / 2)}"/>` +
        `<feComposite in2="hardAlpha" operator="out"/>` +
        `<feColorMatrix type="matrix" values="0 0 0 0 ${n(parseInt(d.c.hex.slice(1, 3), 16) / 255)} 0 0 0 0 ${n(
          parseInt(d.c.hex.slice(3, 5), 16) / 255,
        )} 0 0 0 0 ${n(parseInt(d.c.hex.slice(5, 7), 16) / 255)} 0 0 0 ${n(d.c.a)} 0"/>` +
        `<feBlend mode="normal" in2="${prev}" result="effect${i + 1}_dropShadow"/>`;
      prev = `effect${i + 1}_dropShadow`;
    });
    body += `<feBlend mode="normal" in="SourceGraphic" in2="${prev}" result="shape"/>`;
    defs.push(
      `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">${body}</filter>`,
    );
    return { filter: fid, rings, insets };
  }

  /** linear-gradient(...) → <linearGradient> в координатах рамки; прочие градиенты — первым цветом. */
  function gradient(src, x, y, w, h) {
    const m = /^(linear|radial)-gradient\((.*)\)$/s.exec(src.trim());
    if (!m) return null;
    const parts = splitTop(m[2]);
    let angle = 180;
    let center = [0.5, 0.5];
    let radius = null;
    if (m[1] === 'radial' && !/^(rgba?|#|color)/.test(parts[0])) {
      const at = /at\s+([\d.]+)%\s+([\d.]+)%/.exec(parts[0]);
      if (at) center = [Number(at[1]) / 100, Number(at[2]) / 100];
      const size = /^([\d.]+)%\s+([\d.]+)%/.exec(parts[0]);
      if (size) radius = ((Number(size[1]) / 100) * w + (Number(size[2]) / 100) * h) / 2;
    }
    if (m[1] === 'linear') {
      const first = parts[0];
      if (/deg$/.test(first)) angle = parseFloat(first);
      else if (/^to /.test(first)) {
        const dir = first.slice(3);
        angle =
          {
            top: 0,
            right: 90,
            bottom: 180,
            left: 270,
            'top right': 45,
            'right top': 45,
            'bottom right': 135,
            'right bottom': 135,
            'bottom left': 225,
            'left bottom': 225,
            'top left': 315,
            'left top': 315,
          }[dir] ?? 180;
      }
      if (/deg$|^to /.test(first)) parts.shift();
    } else if (!/^(rgba?|#|color)/.test(parts[0])) parts.shift();
    const stops = parts
      .map((p) => {
        const cm = /(rgba?\([^)]*\)|#[0-9a-f]+|color\([^)]*\)|transparent)/i.exec(p);
        if (!cm) return null;
        const off = /(-?[\d.]+)%/.exec(p.replace(cm[1], ''));
        return {
          c: color(cm[1], true) ?? { hex: '#000000', a: 0 },
          off: off ? parseFloat(off[1]) / 100 : null,
        };
      })
      .filter(Boolean);
    if (!stops.length) return null;
    stops.forEach((s, i) => {
      if (s.off === null) s.off = stops.length === 1 ? 0 : i / (stops.length - 1);
    });
    const gid = id('g');
    const st = stops
      .map(
        (s) =>
          `<stop offset="${n(s.off)}" stop-color="${s.c.hex}"${s.c.a < 1 ? ` stop-opacity="${n(s.c.a)}"` : ''}/>`,
      )
      .join('');
    if (m[1] === 'radial') {
      defs.push(
        `<radialGradient id="${gid}" cx="${n(x + w * center[0])}" cy="${n(y + h * center[1])}" r="${n(radius ?? Math.max(w, h) / 2)}" gradientUnits="userSpaceOnUse">${st}</radialGradient>`,
      );
      return gid;
    }
    const rad = (angle * Math.PI) / 180;
    const len = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    const cx = x + w / 2;
    const cy = y + h / 2;
    const dx = (Math.sin(rad) * len) / 2;
    const dy = (-Math.cos(rad) * len) / 2;
    defs.push(
      `<linearGradient id="${gid}" x1="${n(cx - dx)}" y1="${n(cy - dy)}" x2="${n(cx + dx)}" y2="${n(cy + dy)}" gradientUnits="userSpaceOnUse">${st}</linearGradient>`,
    );
    return gid;
  }

  /** Растр в data-URL: картинка, кадр видео, холст. Чужой источник без CORS — null. */
  async function raster(source, w, h, jpeg) {
    try {
      const sw = source.videoWidth || source.naturalWidth || source.width;
      const sh = source.videoHeight || source.naturalHeight || source.height;
      if (!sw || !sh) return null;
      const k = Math.min(1, maxImage / Math.max(sw, sh), Math.max((2 * w) / sw, (2 * h) / sh, 0.05));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(sw * k));
      cv.height = Math.max(1, Math.round(sh * k));
      cv.getContext('2d').drawImage(source, 0, 0, cv.width, cv.height);
      return cv.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.86);
    } catch {
      return null;
    }
  }
  async function imageFromUrl(url) {
    if (url.startsWith('data:image/svg')) return url;
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
      setTimeout(() => resolve(null), 4000);
    });
  }

  const SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'HEAD',
    'META',
    'LINK',
    'TITLE',
    'BR',
    'WBR',
  ]);
  const KIND = {
    BUTTON: 'кнопка',
    A: 'ссылка',
    INPUT: 'поле',
    TEXTAREA: 'поле',
    SELECT: 'список',
    H1: 'заголовок',
    H2: 'заголовок',
    H3: 'заголовок',
    H4: 'заголовок',
    IMG: 'картинка',
    VIDEO: 'видео',
    CANVAS: 'холст',
    NAV: 'навигация',
    HEADER: 'шапка',
    ASIDE: 'панель',
    MAIN: 'основное',
    FOOTER: 'подвал',
    DIALOG: 'окно',
    UL: 'список',
    OL: 'список',
    LI: 'пункт',
    LABEL: 'подпись',
    FORM: 'форма',
    SECTION: 'раздел',
    ARTICLE: 'карточка',
    IFRAME: 'встройка',
  };
  const ROLE = {
    dialog: 'окно',
    alertdialog: 'окно',
    menu: 'меню',
    menuitem: 'пункт меню',
    menuitemcheckbox: 'пункт меню',
    menuitemradio: 'пункт меню',
    tab: 'вкладка',
    tablist: 'вкладки',
    tabpanel: 'вкладка',
    switch: 'переключатель',
    slider: 'ползунок',
    status: 'статус',
    alert: 'предупреждение',
    listbox: 'список',
    option: 'вариант',
    toolbar: 'панель',
    navigation: 'навигация',
    group: 'группа',
    region: 'область',
    button: 'кнопка',
    checkbox: 'флажок',
    radio: 'выбор',
    tooltip: 'подсказка',
    progressbar: 'полоса',
    note: 'заметка',
    img: 'картинка',
    separator: 'разделитель',
  };
  function label(el) {
    const role = el.getAttribute('role');
    const kind = ROLE[role] || KIND[el.tagName] || null;
    let text =
      el.getAttribute('aria-label') ||
      (el.tagName === 'IMG' && el.alt) ||
      (['BUTTON', 'A', 'H1', 'H2', 'H3', 'H4', 'LABEL'].includes(el.tagName) ||
      role === 'menuitem' ||
      role === 'tab' ||
      role === 'option'
        ? (el.textContent || '').trim().replace(/\s+/g, ' ')
        : '') ||
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
        ? el.placeholder || el.getAttribute('aria-label') || ''
        : '');
    text = (text || '').slice(0, 40);
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    if (kind && text) return `${kind} «${text}»`;
    if (kind) return cls ? `${kind} .${cls}` : kind;
    if (text) return `«${text}»`;
    return cls ? `.${cls}` : el.tagName.toLowerCase();
  }
  const meaningful = (el) =>
    !!(el.getAttribute('role') || el.getAttribute('aria-label') || KIND[el.tagName]) ||
    (typeof el.className === 'string' &&
      /(^|\s)(ui-|tile|dock|panel|card|stage|header|menu|dialog|sheet|row|group|toast|badge|chip|avatar|seat|board|table)/.test(
        el.className,
      ));

  function fontStyle(cs) {
    const w = Number(cs.fontWeight) || 400;
    const name =
      w >= 850
        ? 'Black'
        : w >= 750
          ? 'Extra Bold'
          : w >= 650
            ? 'Bold'
            : w >= 550
              ? 'Semi Bold'
              : w >= 450
                ? 'Medium'
                : w >= 350
                  ? 'Regular'
                  : w >= 250
                    ? 'Light'
                    : 'Extra Light';
    const italic = cs.fontStyle === 'italic' ? (name === 'Regular' ? 'Italic' : `${name} Italic`) : name;
    return italic;
  }
  function family(cs) {
    const f = cs.fontFamily.toLowerCase();
    if (/mono|consolas|menlo|courier/.test(f) && !/inter/.test(f.split(',')[0])) return 'Roboto Mono';
    return 'Inter';
  }
  function transformText(s, cs) {
    if (cs.textTransform === 'uppercase') return s.toUpperCase();
    if (cs.textTransform === 'lowercase') return s.toLowerCase();
    if (cs.textTransform === 'capitalize') return s.replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());
    return s;
  }

  /** Текстовый узел → строки, как их разложил браузер: группы слов по верхнему краю. */
  function textLines(node, cs) {
    const text = node.textContent;
    const range = document.createRange();
    const lines = [];
    const pre = /^(pre|pre-wrap|break-spaces)$/.test(cs.whiteSpace);
    const re = pre ? /[^\n]+/g : /\S+/g;
    let m;
    while ((m = re.exec(text))) {
      // Слово может само переноситься (длинная ссылка) — тогда по символам.
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0);
      if (!rects.length) continue;
      const pieces = rects.length === 1 ? [{ r: rects[0], s: m.index, e: m.index + m[0].length }] : [];
      if (rects.length > 1) {
        let cur = null;
        for (let i = m.index; i < m.index + m[0].length; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getClientRects()[0];
          if (!r) continue;
          if (cur && Math.abs(r.top - cur.r.top) < 2) {
            cur.e = i + 1;
            cur.r = {
              left: cur.r.left,
              top: cur.r.top,
              right: r.right,
              bottom: r.bottom,
              height: cur.r.height,
            };
          } else {
            cur = {
              r: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, height: r.height },
              s: i,
              e: i + 1,
            };
            pieces.push(cur);
          }
        }
      }
      for (const p of pieces) {
        const last = lines[lines.length - 1];
        if (last && Math.abs(p.r.top - last.top) < Math.max(2, p.r.height * 0.4)) {
          last.e = p.e;
          last.right = Math.max(last.right, p.r.right);
          last.left = Math.min(last.left, p.r.left);
        } else
          lines.push({ s: p.s, e: p.e, left: p.r.left, right: p.r.right, top: p.r.top, height: p.r.height });
      }
    }
    return lines.map((l) => ({
      ...l,
      text: pre ? text.slice(l.s, l.e) : text.slice(l.s, l.e).replace(/\s+/g, ' '),
    }));
  }

  /** Обрезка «…»: сколько символов строки помещается до правого края блока. */
  function ellipsize(node, line, limitRight) {
    const range = document.createRange();
    const ell = 0.6 * 14;
    let lo = line.s;
    for (let i = line.s; i < line.e; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getClientRects()[0];
      if (r && r.right > limitRight - ell) break;
      lo = i + 1;
    }
    return node.textContent.slice(line.s, lo).replace(/\s+/g, ' ').trimEnd() + '…';
  }

  function textSvg(el, cs, out, clipRight) {
    const fs = parseFloat(cs.fontSize) || 14;
    const c = color(
      cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color ? cs.webkitTextFillColor : cs.color,
    );
    if (!c) return;
    const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0;
    const lh = cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight);
    const align =
      cs.textAlign === 'center'
        ? 'center'
        : cs.textAlign === 'right' || cs.textAlign === 'end'
          ? 'right'
          : 'left';
    const deco = /underline/.test(cs.textDecorationLine)
      ? ' u'
      : /line-through/.test(cs.textDecorationLine)
        ? ' s'
        : '';
    const ellipsis = cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1;
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || !node.textContent.trim()) continue;
      const lines = textLines(node, cs);
      if (!lines.length) continue;
      const rows = lines
        .map((l) => {
          let t = l.text;
          if (ellipsis && l.right > clipRight + 1) t = ellipsize(node, l, clipRight);
          t = transformText(t, cs);
          if (!t.trim()) return null;
          // Базовая линия Inter: верх области содержимого + 0,96875 кегля.
          const y = l.top + oy + (l.height - fs * 1.21) / 2 + fs * 0.96875;
          return `<tspan x="${n(l.left + ox)}" y="${n(y)}">${esc(t)}</tspan>`;
        })
        .filter(Boolean);
      if (!rows.length) continue;
      const first = lines[0].text.trim().slice(0, 36);
      const step = lines.length > 1 ? n(lines[1].top - lines[0].top) : lh ? n(lh) : 0;
      const meta = `⟦${fontStyle(cs)}|${n(ls)}|${step}|${align}${deco}⟧`;
      out.push(
        `<text id="${esc(first)} ${meta}" fill="${c.hex}"${c.a < 1 ? ` fill-opacity="${n(c.a)}"` : ''} font-family="${family(cs)}" font-size="${n(
          fs,
        )}" font-weight="${Number(cs.fontWeight) >= 600 ? 700 : 400}" xml:space="preserve">${rows.join('')}</text>`,
      );
      count++;
    }
  }

  /** Встроенный значок SVG: пути с вычисленными цветами, без вложенного <svg> (Figma залила бы его белым). */
  function iconSvg(svg, x, y, w, h, name) {
    const vb = svg.viewBox?.baseVal;
    const vw = vb && vb.width ? vb.width : w;
    const vh = vb && vb.height ? vb.height : h;
    const vx = vb && vb.width ? vb.x : 0;
    const vy = vb && vb.height ? vb.y : 0;
    const s = Math.min(w / vw, h / vh);
    const tx = x + (w - vw * s) / 2 - vx * s;
    const ty = y + (h - vh * s) / 2 - vy * s;
    const clone = svg.cloneNode(true);
    const src = [svg, ...svg.querySelectorAll('*')];
    const dst = [clone, ...clone.querySelectorAll('*')];
    const prefix = id('i');
    src.forEach((el, i) => {
      const d = dst[i];
      if (el.tagName === 'title' || el.tagName === 'desc') return d.remove();
      const cs = getComputedStyle(el);
      if (i > 0 && cs.display === 'none') return d.remove();
      for (const [prop, attr] of [
        ['fill', 'fill'],
        ['stroke', 'stroke'],
        ['strokeWidth', 'stroke-width'],
        ['strokeLinecap', 'stroke-linecap'],
        ['strokeLinejoin', 'stroke-linejoin'],
        ['fillRule', 'fill-rule'],
        ['fillOpacity', 'fill-opacity'],
        ['strokeOpacity', 'stroke-opacity'],
        ['opacity', 'opacity'],
      ]) {
        let v = cs[prop];
        if (!v) continue;
        if ((prop === 'fill' || prop === 'stroke') && v.startsWith('url(')) {
          v = v.replace(/url\("?#([^")]+)"?\)/, (mm, ref) => `url(#${prefix}${ref})`);
        } else if (prop === 'fill' || prop === 'stroke') {
          const c = color(v);
          if (!c) v = 'none';
          else {
            v = c.hex;
            if (c.a < 1)
              d.setAttribute(
                `${attr}-opacity`,
                String(n(c.a * Number(cs[prop === 'fill' ? 'fillOpacity' : 'strokeOpacity'] || 1))),
              );
          }
        }
        if (prop === 'opacity' && v === '1') continue;
        d.setAttribute(attr, v);
      }
      if (d.id) d.id = prefix + d.id;
      for (const a of ['clip-path', 'mask', 'filter']) {
        const v = d.getAttribute(a);
        if (v)
          d.setAttribute(
            a,
            v.replace(/url\("?#([^")]+)"?\)/, (mm, ref) => `url(#${prefix}${ref})`),
          );
      }
      if (i > 0) d.removeAttribute('class');
      d.removeAttribute('style');
    });
    return `<g id="значок ${esc(name)}" transform="matrix(${n(s)} 0 0 ${n(s)} ${n(tx)} ${n(ty)})">${clone.innerHTML}</g>`;
  }

  function hasRotation(cs) {
    if ((cs.rotate && cs.rotate !== 'none') || (cs.transform && cs.transform !== 'none')) {
      if (cs.rotate && cs.rotate !== 'none') return true;
      const m = new DOMMatrix(cs.transform);
      return Math.abs(m.b) > 0.001 || Math.abs(m.c) > 0.001;
    }
    return false;
  }

  /** Порядок отрисовки братьев: отрицательный z, обычные, позиционированные по z. */
  function paintOrder(children) {
    return children
      .map((el, i) => {
        const cs = getComputedStyle(el);
        const positioned = cs.position !== 'static';
        const z = cs.zIndex === 'auto' ? 0 : Number(cs.zIndex) || 0;
        const key = positioned || cs.zIndex !== 'auto' ? (z < 0 ? -1e6 + z : 1 + z) : 0;
        return { el, i, key };
      })
      .sort((a, b) => a.key - b.key || a.i - b.i)
      .map((x) => x.el);
  }

  async function pseudo(el, cs, which, x, y, w, h, out) {
    const p = getComputedStyle(el, which);
    if (!p || p.content === 'none' || p.content === 'normal' || p.display === 'none') return;
    if (!['absolute', 'fixed'].includes(p.position)) return;
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const iw = w - bl - (parseFloat(cs.borderRightWidth) || 0);
    const ih = h - bt - (parseFloat(cs.borderBottomWidth) || 0);
    const px = (v) => (v && v.endsWith('px') ? parseFloat(v) : v && v.endsWith('%') ? null : null);
    let pw = px(p.width);
    let ph = px(p.height);
    const L = px(p.left);
    const R = px(p.right);
    const T = px(p.top);
    const B = px(p.bottom);
    if (pw === null && L !== null && R !== null) pw = iw - L - R;
    if (ph === null && T !== null && B !== null) ph = ih - T - B;
    if (!pw || !ph || pw <= 0 || ph <= 0) return;
    const px0 = L !== null ? x + bl + L : R !== null ? x + bl + iw - R - pw : x + bl;
    const py0 = T !== null ? y + bt + T : B !== null ? y + bt + ih - B - ph : y + bt;
    const bg = color(p.backgroundColor);
    const r = radii(p, pw, ph);
    const parts = [];
    if (bg) parts.push(shape(px0 + ox, py0 + oy, pw, ph, r, paint('fill', bg)));
    if (p.backgroundImage && p.backgroundImage !== 'none') {
      const g = gradient(splitTop(p.backgroundImage)[0], px0 + ox, py0 + oy, pw, ph);
      if (g) parts.push(shape(px0 + ox, py0 + oy, pw, ph, r, ` fill="url(#${g})"`));
    }
    const bw = parseFloat(p.borderTopWidth) || 0;
    const bc = color(p.borderTopColor);
    if (bw && bc && p.borderTopStyle !== 'none')
      parts.push(
        shape(
          px0 + ox + bw / 2,
          py0 + oy + bw / 2,
          pw - bw,
          ph - bw,
          r.map((v) => Math.max(0, v - bw / 2)),
          ` fill="none"${paint('stroke', bc)} stroke-width="${n(bw)}"`,
        ),
      );
    if (parts.length) {
      out.push(
        `<g id="${which === '::before' ? 'до' : 'после'} ${esc(label(el))}"${Number(p.opacity) < 1 ? ` opacity="${n(Number(p.opacity))}"` : ''}>${parts.join('')}</g>`,
      );
      count++;
    }
  }

  async function render(el, out, clipRight) {
    if (SKIP.has(el.tagName) || count > 9000) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    const opacity = Number(cs.opacity);
    if (opacity === 0) return;
    if (cs.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(50%\)/.test(cs.clipPath)) return;
    const visible = cs.visibility !== 'hidden';
    // Повёрнутый элемент меряется без поворота, а поворот — матрицей группы.
    let restore = null;
    let matrix = null;
    if (hasRotation(cs) && el.tagName !== 'svg') {
      const before = el.getBoundingClientRect();
      const m = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform);
      const rot = cs.rotate && cs.rotate !== 'none' ? parseFloat(cs.rotate) : 0;
      const prev = [
        el.style.getPropertyValue('transform'),
        el.style.getPropertyPriority('transform'),
        el.style.getPropertyValue('rotate'),
        el.style.getPropertyValue('transition'),
      ];
      el.style.setProperty('transition', 'none', 'important');
      el.style.setProperty('transform', 'none', 'important');
      el.style.setProperty('rotate', 'none', 'important');
      const flat = el.getBoundingClientRect();
      const [tox, toy] = cs.transformOrigin.split(' ').map(parseFloat);
      const cx = flat.left + ox + tox;
      const cy = flat.top + oy + toy;
      const full = new DOMMatrix().translate(cx, cy).rotate(rot).multiply(m).translate(-cx, -cy);
      matrix = `matrix(${[full.a, full.b, full.c, full.d, full.e, full.f].map(n).join(' ')})`;
      if (
        Math.abs(before.width - flat.width) < 0.5 &&
        Math.abs(before.height - flat.height) < 0.5 &&
        !rot &&
        Math.abs(m.b) < 0.001
      )
        matrix = null;
      restore = () => {
        el.style.setProperty('transform', prev[0], prev[1]);
        el.style.setProperty('rotate', prev[2]);
        el.style.setProperty('transition', prev[3]);
        if (!prev[0]) el.style.removeProperty('transform');
        if (!prev[2]) el.style.removeProperty('rotate');
        if (!prev[3]) el.style.removeProperty('transition');
      };
    }
    try {
      const rect = el.getBoundingClientRect();
      const x = rect.left + ox;
      const y = rect.top + oy;
      const w = rect.width;
      const h = rect.height;
      if (w <= 1 && h <= 1 && cs.overflow !== 'visible') return;
      const parts = [];
      const r = radii(cs, w, h);
      let filterId = null;
      if (visible && w > 0 && h > 0) {
        const { filter, rings, insets } = shadows(cs);
        for (const ring of rings)
          parts.push(
            shape(
              x - ring.spread / 2,
              y - ring.spread / 2,
              w + ring.spread,
              h + ring.spread,
              r.map((v) => v + ring.spread / 2),
              ` fill="none"${paint('stroke', ring.c)} stroke-width="${n(ring.spread)}"`,
            ),
          );
        const bg = color(cs.backgroundColor);
        filterId = filter;
        if (bg)
          parts.push(shape(x, y, w, h, r, paint('fill', bg) + (filter ? ` filter="url(#${filter})"` : '')));
        else if (filter)
          parts.push(shape(x, y, w, h, r, ` fill="#000000" fill-opacity="0.001" filter="url(#${filter})"`));
        if (cs.backgroundImage && cs.backgroundImage !== 'none') {
          const layers = splitTop(cs.backgroundImage).reverse();
          for (const layer of layers) {
            if (/gradient\(/.test(layer)) {
              const g = gradient(layer, x, y, w, h);
              if (g) parts.push(shape(x, y, w, h, r, ` fill="url(#${g})"`));
            } else {
              const um = /url\("?([^")]+)"?\)/.exec(layer);
              if (!um) continue;
              const img = await imageFromUrl(um[1]);
              let href = typeof img === 'string' ? img : img ? await raster(img, w, h, false) : null;
              if (!href) continue;
              const size = cs.backgroundSize;
              let iw = w;
              let ih = h;
              let ix = x;
              let iy = y;
              let par = 'none';
              if (size === 'cover') par = 'xMidYMid slice';
              else if (size === 'contain') par = 'xMidYMid meet';
              else if (/px/.test(size)) {
                const [a, b] = size.split(' ').map(parseFloat);
                iw = a;
                ih = b || a;
                const [pxp, pyp] = cs.backgroundPosition.split(' ');
                const pos = (v, room) =>
                  v?.endsWith('%') ? (parseFloat(v) / 100) * room : parseFloat(v) || 0;
                ix = x + pos(pxp, w - iw);
                iy = y + pos(pyp, h - ih);
              }
              const cid = id('c');
              defs.push(`<clipPath id="${cid}">${shape(x, y, w, h, r)}</clipPath>`);
              parts.push(
                `<g id="фон-картинка" clip-path="url(#${cid})"><image x="${n(ix)}" y="${n(iy)}" width="${n(iw)}" height="${n(ih)}" preserveAspectRatio="${par}" href="${href}"/></g>`,
              );
            }
          }
        }
        // Рамка: одинаковая со всех сторон — обводкой по форме, иначе — полосками.
        const sides = ['Top', 'Right', 'Bottom', 'Left'].map((s) => ({
          w: cs[`border${s}Style`] === 'none' ? 0 : parseFloat(cs[`border${s}Width`]) || 0,
          c: color(cs[`border${s}Color`]),
          dashed: /dash|dot/.test(cs[`border${s}Style`]),
        }));
        const same = sides.every(
          (s) => s.w === sides[0].w && s.c?.hex === sides[0].c?.hex && s.c?.a === sides[0].c?.a,
        );
        if (same && sides[0].w > 0 && sides[0].c) {
          const bw = sides[0].w;
          parts.push(
            shape(
              x + bw / 2,
              y + bw / 2,
              w - bw,
              h - bw,
              r.map((v) => Math.max(0, v - bw / 2)),
              ` fill="none"${paint('stroke', sides[0].c)} stroke-width="${n(bw)}"${sides[0].dashed ? ' stroke-dasharray="4 3"' : ''}`,
            ),
          );
        } else {
          const [t, rr, b, l] = sides;
          if (t.w && t.c)
            parts.push(
              `<rect id="рамка сверху" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(t.w)}"${paint('fill', t.c)}/>`,
            );
          if (b.w && b.c)
            parts.push(
              `<rect id="рамка снизу" x="${n(x)}" y="${n(y + h - b.w)}" width="${n(w)}" height="${n(b.w)}"${paint('fill', b.c)}/>`,
            );
          if (l.w && l.c)
            parts.push(
              `<rect id="рамка слева" x="${n(x)}" y="${n(y)}" width="${n(l.w)}" height="${n(h)}"${paint('fill', l.c)}/>`,
            );
          if (rr.w && rr.c)
            parts.push(
              `<rect id="рамка справа" x="${n(x + w - rr.w)}" y="${n(y)}" width="${n(rr.w)}" height="${n(h)}"${paint('fill', rr.c)}/>`,
            );
        }
        for (const ins of insets) {
          if (!ins.dx && !ins.dy && ins.spread > 0)
            parts.push(
              shape(
                x + ins.spread / 2,
                y + ins.spread / 2,
                w - ins.spread,
                h - ins.spread,
                r.map((v) => Math.max(0, v - ins.spread / 2)),
                ` fill="none"${paint('stroke', ins.c)} stroke-width="${n(ins.spread)}"`,
              ),
            );
          else if (ins.dy && !ins.dx)
            parts.push(
              `<rect id="полоска ${ins.dy > 0 ? 'сверху' : 'снизу'}" x="${n(x + r[0] / 2)}" y="${n(ins.dy > 0 ? y : y + h + ins.dy)}" width="${n(w - r[0])}" height="${n(Math.abs(ins.dy) + Math.max(0, ins.spread))}"${paint('fill', ins.c)}/>`,
            );
          else if (ins.dx && !ins.dy)
            parts.push(
              `<rect id="полоска ${ins.dx > 0 ? 'слева' : 'справа'}" x="${n(ins.dx > 0 ? x : x + w + ins.dx)}" y="${n(y)}" width="${n(Math.abs(ins.dx) + Math.max(0, ins.spread))}" height="${n(h)}"${paint('fill', ins.c)}/>`,
            );
        }
      }

      const inner = [];
      const clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || /paint/.test(cs.contain);
      const childClipRight = clips
        ? Math.min(clipRight, rect.right - (parseFloat(cs.paddingRight) || 0) * 0)
        : clipRight;
      const tag = el.tagName;

      if (visible && (tag === 'svg' || el instanceof SVGSVGElement)) {
        if (w > 0 && h > 0) inner.push(iconSvg(el, x, y, w, h, label(el)));
        count++;
      } else if (visible && (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS')) {
        const src = tag === 'IMG' ? el.currentSrc || el.src : '';
        // Картинка-SVG по адресу — ссылкой: Node впишет её векторной группой (figma-screens.mjs).
        const vectorSrc = /\.svg(\?|$)/.test(src) && !src.startsWith('data:');
        const href = vectorSrc
          ? null
          : src.startsWith('data:image/svg')
            ? src
            : await raster(el, w, h, tag !== 'IMG');
        const fit =
          cs.objectFit === 'cover'
            ? 'xMidYMid slice'
            : cs.objectFit === 'contain' || tag === 'VIDEO'
              ? 'xMidYMid meet'
              : 'none';
        if (href) {
          const cid = id('c');
          defs.push(`<clipPath id="${cid}">${shape(x, y, w, h, r)}</clipPath>`);
          const mirror = tag === 'VIDEO' && /matrix\(-1/.test(cs.transform);
          inner.push(
            `<g id="${esc(label(el))}" clip-path="url(#${cid})"><image x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="${fit}" href="${href}"${
              mirror ? ` transform="matrix(-1 0 0 1 ${n(2 * x + w)} 0)"` : ''
            }/></g>`,
          );
        } else if (tag === 'IMG' && (el.currentSrc || el.src)) {
          // Чужая картинка без CORS: Node подставит её сам по ссылке.
          inner.push(
            `<image id="${esc(label(el))}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="${fit}" href="${esc(el.currentSrc || el.src)}"/>`,
          );
        } else {
          inner.push(
            `<rect id="${esc(label(el))} (пусто)" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="#000000" fill-opacity="0.2"/>`,
          );
        }
        count++;
      } else if (
        visible &&
        tag === 'INPUT' &&
        (el.type === 'checkbox' || el.type === 'radio') &&
        cs.appearance !== 'none'
      ) {
        // Родные флажок и переключатель: рисуем, как Chromium, в цвете accent-color.
        const accent = color(cs.accentColor && cs.accentColor !== 'auto' ? cs.accentColor : '#3564f3');
        const line = color(
          cs.colorScheme === 'dark' || /dark/.test(document.documentElement.dataset.theme || '')
            ? '#8a93a5'
            : '#767676',
        );
        const s = Math.min(w, h);
        const cx = x + w / 2;
        const cy = y + h / 2;
        if (el.type === 'radio') {
          inner.push(
            el.checked
              ? `<g id="выбор (вкл)"><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(s / 2 - 0.5)}" fill="none"${paint('stroke', accent)} stroke-width="1"/><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(s / 2 - 3.5)}"${paint('fill', accent)}/></g>`
              : `<circle id="выбор (выкл)" cx="${n(cx)}" cy="${n(cy)}" r="${n(s / 2 - 0.5)}" fill="none"${paint('stroke', line)} stroke-width="1"/>`,
          );
        } else {
          inner.push(
            el.checked
              ? `<g id="флажок (вкл)"><rect x="${n(cx - s / 2)}" y="${n(cy - s / 2)}" width="${n(s)}" height="${n(s)}" rx="2"${paint('fill', accent)}/><path d="M${n(cx - s * 0.28)} ${n(cy)}L${n(cx - s * 0.06)} ${n(cy + s * 0.22)}L${n(cx + s * 0.3)} ${n(cy - s * 0.22)}" fill="none" stroke="#ffffff" stroke-width="${n(Math.max(1.5, s / 8))}" stroke-linecap="round" stroke-linejoin="round"/></g>`
              : `<rect id="флажок (выкл)" x="${n(cx - s / 2 + 0.5)}" y="${n(cy - s / 2 + 0.5)}" width="${n(s - 1)}" height="${n(s - 1)}" rx="2" fill="none"${paint('stroke', line)} stroke-width="1"/>`,
          );
        }
        count++;
      } else if (tag === 'IFRAME') {
        inner.push(
          `<rect id="встройка ${esc(el.title || el.src || '')}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="#000000"/>`,
        );
      } else {
        if (
          visible &&
          (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') &&
          !['checkbox', 'radio', 'range', 'hidden', 'color', 'file'].includes(el.type)
        ) {
          const value = tag === 'SELECT' ? (el.selectedOptions?.[0]?.textContent ?? '') : el.value;
          const ph = !value && el.placeholder;
          const shown = (
            ph ? el.placeholder : el.type === 'password' ? '•'.repeat(value.length) : value
          ).split('\n')[0];
          if (shown) {
            const pcs = ph ? getComputedStyle(el, '::placeholder') : cs;
            const c = color(pcs.color) ?? color(cs.color);
            const fs = parseFloat(cs.fontSize) || 14;
            const px0 = x + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
            const top =
              tag === 'TEXTAREA'
                ? y + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0)
                : y + h / 2 - (fs * 1.21) / 2;
            const meta = `⟦${fontStyle(cs)}|0|0|left⟧`;
            if (c)
              inner.push(
                `<text id="${esc(shown.slice(0, 36))} ${meta}" fill="${c.hex}"${c.a < 1 ? ` fill-opacity="${n(c.a)}"` : ''} font-family="${family(cs)}" font-size="${n(fs)}" xml:space="preserve"><tspan x="${n(px0)}" y="${n(top + fs * 0.96875)}">${esc(shown)}</tspan></text>`,
              );
          }
        }
        if (visible) textSvg(el, cs, inner, clips ? Math.min(clipRight, rect.right) : clipRight);
        await pseudo(el, cs, '::before', rect.left, rect.top, w, h, inner);
        for (const child of paintOrder([...el.children])) await render(child, inner, childClipRight);
        await pseudo(el, cs, '::after', rect.left, rect.top, w, h, inner);
        count++;
      }

      if (!parts.length && !inner.length) return;
      let body = parts.join('');
      if (inner.length) {
        if (clips && w > 0 && h > 0) {
          const cid = id('c');
          const bl = parseFloat(cs.borderLeftWidth) || 0;
          const bt = parseFloat(cs.borderTopWidth) || 0;
          const br = parseFloat(cs.borderRightWidth) || 0;
          const bb = parseFloat(cs.borderBottomWidth) || 0;
          defs.push(
            `<clipPath id="${cid}">${shape(
              x + bl,
              y + bt,
              w - bl - br,
              h - bt - bb,
              r.map((v) => Math.max(0, v - Math.max(bl, bt))),
            )}</clipPath>`,
          );
          body += `<g id="содержимое" clip-path="url(#${cid})">${inner.join('')}</g>`;
        } else body += inner.join('');
      }
      const needGroup =
        parts.length > 1 || opacity < 1 || matrix || meaningful(el) || (parts.length && inner.length);
      if (!needGroup) {
        out.push(body);
        return;
      }
      out.push(
        `<g id="${esc(label(el))}"${opacity < 1 ? ` opacity="${n(opacity)}"` : ''}${matrix ? ` transform="${matrix}"` : ''}>${body}</g>`,
      );
    } finally {
      restore?.();
    }
  }

  const out = [];
  const bodyBg = color(getComputedStyle(document.body).backgroundColor) ??
    color(getComputedStyle(de).backgroundColor) ?? { hex: '#ffffff', a: 1 };
  await render(document.body, out, W);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs>${defs.join('')}</defs>` +
    `<rect id="фон страницы" width="${W}" height="${H}" fill="${bodyBg.hex}"/>` +
    out.join('') +
    `</svg>`;
  return { svg, w: W, h: H, nodes: count, bytes: svg.length };
}

/**
 * Аудит чёткости (E15 B5, T29) — по живой странице, рядом со снимком:
 * переполнение по ширине, элементы за краем, обрезанный текст, перекрытые кнопки, мутные растровые
 * картинки, дробные тонкие линии, контраст текста. Возвращает счёт и до 8 примеров на класс.
 */
export function auditPage() {
  const de = document.documentElement;
  const W = de.clientWidth;
  const dpr = devicePixelRatio || 1;
  const out = {
    overflowX: Math.max(0, de.scrollWidth - de.clientWidth),
    offscreen: [],
    clipped: [],
    truncated: [],
    covered: [],
    blurry: [],
    fractional: [],
    contrast: [],
  };
  const push = (list, item) => {
    if (list.length < 8) list.push(item);
    list.n = (list.n ?? 0) + 1;
  };
  const name = (el) => {
    const t = (el.getAttribute('aria-label') || el.textContent || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 40);
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${t ? ` «${t}»` : ''}`;
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const rgb = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1]
      .split(/[ ,/]+/)
      .filter(Boolean)
      .map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    let stack = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none' && !/gradient/.test(cs.backgroundImage)) return null;
      const c = rgb(cs.backgroundColor);
      if (c && c.a > 0) {
        stack.push(c);
        if (c.a >= 0.99) break;
      }
      if (/VIDEO|CANVAS|IMG/.test(e.tagName)) return null;
    }
    let base = { r: 255, g: 255, b: 255 };
    for (const c of stack.reverse())
      base = {
        r: c.r * c.a + base.r * (1 - c.a),
        g: c.g * c.a + base.g * (1 - c.a),
        b: c.b * c.a + base.b * (1 - c.a),
      };
    return base;
  };
  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const interactive = el.matches(
      'button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [role="tab"]',
    );
    if (interactive && (r.right > W + 1 || r.left < -1) && cs.position !== 'fixed')
      push(out.offscreen, name(el));
    const ownText = [...el.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim());
    if (ownText) {
      if (el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'visible')
        push(cs.textOverflow === 'ellipsis' ? out.truncated : out.clipped, name(el));
      else if (
        el.scrollHeight > el.clientHeight + 2 &&
        cs.overflowY === 'hidden' &&
        !cs.webkitLineClamp?.match(/\d/)
      )
        push(out.clipped, name(el));
      const fg = rgb(cs.color);
      const bg = bgOf(el);
      if (fg && bg && fg.a > 0.5) {
        const a = lum(fg);
        const b = lum(bg);
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const large =
          parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
        const disabled = el.closest('[disabled], [aria-disabled="true"]');
        if (ratio < (large ? 3 : 4.5) && !disabled) push(out.contrast, `${name(el)} ${ratio.toFixed(2)}:1`);
      }
    }
    if (interactive && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= W) {
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el))
        push(out.covered, `${name(el)} ← ${name(hit)}`);
    }
    if (
      el.tagName === 'IMG' &&
      el.naturalWidth &&
      !/\.svg/.test(el.currentSrc) &&
      el.naturalWidth < r.width * dpr * 0.9
    )
      push(out.blurry, `${name(el)} ${el.naturalWidth}px < ${Math.round(r.width * dpr)}`);
    const bw = parseFloat(cs.borderTopWidth);
    if (
      (bw > 0 && bw < 1 && bw * dpr < 1) ||
      (r.height > 0 &&
        r.height < 2 &&
        Math.abs(r.top * dpr - Math.round(r.top * dpr)) > 0.05 &&
        cs.backgroundColor !== 'rgba(0, 0, 0, 0)')
    )
      push(out.fractional, `${name(el)} y=${r.top.toFixed(2)}`);
  }
  for (const k of ['offscreen', 'clipped', 'truncated', 'covered', 'blurry', 'fractional', 'contrast'])
    out[k] = { n: out[k].n ?? 0, samples: [...out[k]] };
  return out;
}
