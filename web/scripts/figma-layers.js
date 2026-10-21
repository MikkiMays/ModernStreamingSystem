// Дообработка кадров, импортированных из SVG (`dom-svg.mjs` → `upload_assets`), — код для `use_figma`
// (E15-B). Первая строка задаёт страницу и сколько кадров за раз; повторный запуск пропускает готовые.
//
// 1. Текст: метка `⟦стиль|интервал|шаг строки|выравнивание⟧` в имени → начертание Inter, межбуквенный
//    интервал; строки абзаца (импорт даёт группу из текстов-строк) сливаются в один текст с высотой
//    строки = шагу, как в браузере. Метка из имени убирается.
// 2. Цвет: сплошные заливки и обводки, совпавшие со значением токена темы кадра, привязываются к
//    переменной («Цвет · светлая»/«Цвет · тёмная», иначе — «Палитра»).
// 3. Кадр: имя `<id> · <ширина> · <тема>` остаётся, белая подложка импорта снимается.
const PAGE = '__PAGE__';
const LIMIT = 40;
const page = figma.root.children.find((p) => p.name === PAGE);
await figma.setCurrentPageAsync(page);
const tops = page.children.flatMap((n) => (n.type === 'SECTION' ? n.children : [n]));
const isNew = (n) => n.type === 'FRAME' && (/-(light|dark)$/.test(n.name) || /^(card|section|page)-/.test(n.name) || n.name === 'cover');
const frames = tops.filter(isNew).slice(0, LIMIT);
const STYLES = ['Regular', 'Medium', 'Semi Bold', 'Bold', 'Italic', 'Medium Italic', 'Light', 'Extra Bold', 'Black'];
for (const s of STYLES) await figma.loadFontAsync({ family: 'Inter', style: s }).catch(() => {});
for (const s of ['Regular', 'Medium', 'Bold']) await figma.loadFontAsync({ family: 'Roboto Mono', style: s }).catch(() => {});
const cols = await figma.variables.getLocalVariableCollectionsAsync();
const cname = Object.fromEntries(cols.map((c) => [c.id, c.name]));
const vars = await figma.variables.getLocalVariablesAsync('COLOR');
const byId = Object.fromEntries(vars.map((v) => [v.id, v]));
const resolve = (v) => {
  let val = v.valuesByMode[Object.keys(v.valuesByMode)[0]];
  let guard = 0;
  while (val && val.type === 'VARIABLE_ALIAS' && guard++ < 5) {
    const a = byId[val.id];
    val = a.valuesByMode[Object.keys(a.valuesByMode)[0]];
  }
  return val;
};
const key = (c, a) => [c.r, c.g, c.b].map((x) => Math.round(x * 255)).join(',') + '|' + Math.round(a * 100);
function table(theme) {
  const map = new Map();
  const order = [
    ...vars.filter((v) => cname[v.variableCollectionId] === theme && !v.name.startsWith('component/')),
    ...vars.filter((v) => cname[v.variableCollectionId] === 'Палитра'),
  ];
  for (const v of order) {
    const c = resolve(v);
    if (!c) continue;
    const k = key(c, c.a ?? 1);
    if (!map.has(k)) map.set(k, v);
  }
  return map;
}
const maps = { light: table('Цвет · светлая'), dark: table('Цвет · тёмная') };
function bindPaints(paints, map) {
  if (!Array.isArray(paints)) return [paints, 0];
  let n = 0;
  const out = paints.map((p) => {
    if (p.type !== 'SOLID' || p.boundVariables?.color) return p;
    const v = map.get(key(p.color, p.opacity ?? 1)) ?? map.get(key(p.color, 1));
    if (!v) return p;
    n++;
    const alphaInVar = (resolve(v).a ?? 1) < 1;
    const bound = figma.variables.setBoundVariableForPaint({ ...p, opacity: alphaInVar ? 1 : p.opacity ?? 1 }, 'color', v);
    return bound;
  });
  return [out, n];
}
const MARK = /\s*⟦([^|]*)\|([^|]*)\|([^|]*)\|([^⟧]*)⟧\s*$/;
let merged = 0;
let styled = 0;
let bound = 0;
const done = [];
for (const frame of frames) {
  const theme = frame.name.endsWith('-dark') ? 'dark' : 'light';
  const map = maps[theme];
  frame.fills = [];
  // 1. Текст
  const marked = frame.findAll((n) => MARK.test(n.name));
  for (const node of marked) {
    const [, style, ls, step, alignRaw] = MARK.exec(node.name);
    const [align, deco] = alignRaw.split(' ');
    const texts = node.type === 'TEXT' ? [node] : node.findAll((n) => n.type === 'TEXT');
    if (!texts.length) {
      node.name = node.name.replace(MARK, '');
      continue;
    }
    const family = texts[0].fontName.family === 'Roboto Mono' ? 'Roboto Mono' : 'Inter';
    const fontName = { family, style: family === 'Inter' ? style : style.includes('Bold') ? 'Bold' : style.includes('Medium') ? 'Medium' : 'Regular' };
    const apply = (t) => {
      const before = { x: t.x, w: t.width };
      t.fontName = fontName;
      if (Number(ls)) t.letterSpacing = { unit: 'PIXELS', value: Number(ls) };
      if (deco === 'u') t.textDecoration = 'UNDERLINE';
      if (deco === 's') t.textDecoration = 'STRIKETHROUGH';
      if (align === 'center') t.x = before.x + (before.w - t.width) / 2;
      else if (align === 'right') t.x = before.x + before.w - t.width;
      styled++;
    };
    if (texts.length > 1 && node.type !== 'TEXT' && Number(step) > 0) {
      // Абзац: строки → один текст, шаг строки как в браузере.
      const first = texts[0];
      const parent = node.parent;
      const index = parent.children.indexOf(node);
      const t = figma.createText();
      t.fontName = fontName;
      t.fontSize = first.fontSize;
      t.fills = first.fills;
      t.characters = texts.map((x) => x.characters).join('\n');
      t.lineHeight = { unit: 'PIXELS', value: Number(step) };
      if (Number(ls)) t.letterSpacing = { unit: 'PIXELS', value: Number(ls) };
      if (deco === 'u') t.textDecoration = 'UNDERLINE';
      t.textAlignHorizontal = align === 'center' ? 'CENTER' : align === 'right' ? 'RIGHT' : 'LEFT';
      const left = Math.min(...texts.map((x) => x.x));
      const right = Math.max(...texts.map((x) => x.x + x.width));
      const top = first.y - (Number(step) - first.height) / 2;
      parent.insertChild(index, t);
      t.textAutoResize = 'WIDTH_AND_HEIGHT';
      const w = t.width;
      t.x = align === 'center' ? (left + right) / 2 - w / 2 : align === 'right' ? right - w : left;
      t.y = top;
      t.name = texts[0].characters.slice(0, 40);
      node.remove();
      merged++;
    } else {
      texts.forEach(apply);
      node.name = node.name.replace(MARK, '') || texts[0].characters.slice(0, 40);
    }
  }
  // 2. Цвет
  for (const n of frame.findAll((x) => 'fills' in x || 'strokes' in x)) {
    // Прозрачность обводки пришла прозрачностью фигуры (см. dom-svg.mjs) — вернуть её в краску.
    if (n.type === 'VECTOR' && n.opacity < 1 && !(n.fills?.length) && n.strokes?.length === 1) {
      n.strokes = [{ ...n.strokes[0], opacity: n.opacity }];
      n.opacity = 1;
    }
    if ('fills' in n && Array.isArray(n.fills) && n.fills.length) {
      const [f, k] = bindPaints(n.fills, map);
      if (k) {
        n.fills = f;
        bound += k;
      }
    }
    if ('strokes' in n && n.strokes.length) {
      const [s, k] = bindPaints(n.strokes, map);
      if (k) {
        n.strokes = s;
        bound += k;
      }
    }
  }
  const m = /^(.*)-(\d+)-(light|dark)$/.exec(frame.name);
  if (m) frame.name = `${m[1]} · ${m[2]} · ${m[3] === 'dark' ? 'тёмная' : 'светлая'}`;
  else
    frame.name = frame.name
      .replace(/^card-(.*)$/, 'карточка · $1')
      .replace(/^section-(.*)-(\d+)$/, 'раздел · $1 · $2')
      .replace(/^page-(.*)$/, 'страница · $1')
      .replace(/^cover$/, 'обложка');
  done.push(frame.id);
}
const left = tops.filter(isNew).length - done.length;
return { processed: done.length, merged, styled, bound, left };
