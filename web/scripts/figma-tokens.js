// Токены E16 (`web/src/styles/tokens.css`) → переменные Figma (E15-B). Код для `use_figma`: вставляется
// целиком; повторный запуск обновляет значения, а не плодит переменные. Палитра — скрытые примитивы,
// «Цвет · светлая» и «Цвет · тёмная» — смысловые (псевдонимы палитры, как в CSS; одна мода на коллекцию — предел Starter), «Размеры» и
// «Движение» — числа. Синтаксис кода — имя CSS-переменной в var().
const P = {
  'ink/950': '0a0c11',
  'ink/900': '111419',
  'ink/800': '1a1f28',
  'ink/700': '222834',
  'ink/600': '2c3340',
  'ink/500': '3a4250',
  'ink/400': '525b6b',
  'ink/300': '939daf',
  'ink/200': 'b3bbc9',
  'ink/100': 'd3d8e1',
  'ink/50': 'eef0f4',
  white: 'ffffff',
  'mist/50': 'f6f7fa',
  'mist/100': 'eef0f5',
  'mist/200': 'e1e4eb',
  'mist/300': 'c6ccd6',
  'slate/700': '4d5566',
  'slate/600': '5f6878',
  'slate/900': '1b1f27',
  'blue/50': 'eaf0ff',
  'blue/300': 'a8bbff',
  'blue/400': '7d9bff',
  'blue/500': '3564f3',
  'blue/600': '2d59df',
  'blue/650': '2b55d9',
  'blue/700': '2347b8',
  'blue/900': '1c2a4e',
  'red/50': 'fdeeee',
  'red/300': 'ff8a8f',
  'red/500': 'd4323a',
  'red/600': 'b8262e',
  'red/700': 'c21f29',
  'red/900': '4a1b1f',
  'green/200': '8ff0b8',
  'green/300': '4fd48a',
  'green/400': '45d17f',
  'green/450': '33a865',
  'green/500': '2f9e5f',
  'green/600': '2b7d4f',
  'green/700': '176c3e',
  'amber/300': 'f2c14e',
  'amber/700': '9a6700',
};
const BG = ['FRAME_FILL', 'SHAPE_FILL'];
const TX = ['TEXT_FILL'];
const LN = ['STROKE_COLOR'];
const ANY = ['FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR'];
// [имя, css, scopes, светлая, тёмная]: строка 'blue/500' — псевдоним палитры, массив — сырой цвет [hex, alpha].
const S = [
  ['bg', '--bg', BG, 'mist/50', 'ink/900'],
  ['surface/1', '--surface-1', BG, 'white', 'ink/800'],
  ['surface/2', '--surface-2', BG, 'mist/100', 'ink/700'],
  ['surface/3', '--surface-3', BG, 'white', 'ink/600'],
  ['surface/hover', '--surface-hover', BG, ['1b1f27', 0.05], ['ffffff', 0.05]],
  ['surface/active', '--surface-active', BG, ['1b1f27', 0.09], ['ffffff', 0.09]],
  ['text/default', '--text', TX, 'slate/900', 'ink/50'],
  ['text/secondary', '--text-secondary', TX, 'slate/700', 'ink/200'],
  ['text/muted', '--muted', TX, 'slate/600', 'ink/300'],
  ['text/disabled', '--text-disabled', TX, ['9aa3b2', 1], ['5f6878', 1]],
  ['line/default', '--line', LN, 'mist/200', 'ink/600'],
  ['line/strong', '--line-strong', LN, 'mist/300', 'ink/500'],
  ['accent/default', '--accent', ANY, 'blue/600', 'blue/400'],
  ['accent/hover', '--accent-hover', ANY, 'blue/700', 'blue/300'],
  ['accent/fill', '--accent-fill', BG, 'blue/500', 'blue/500'],
  ['accent/fill-hover', '--accent-fill-hover', BG, 'blue/650', 'blue/650'],
  ['accent/fill-active', '--accent-fill-active', BG, 'blue/700', 'blue/700'],
  ['accent/soft', '--accent-soft', BG, 'blue/50', 'blue/900'],
  ['accent/on', '--on-accent', TX, 'white', 'white'],
  ['danger/default', '--danger', ANY, 'red/700', 'red/300'],
  ['danger/fill', '--danger-fill', BG, 'red/500', 'red/500'],
  ['danger/fill-hover', '--danger-fill-hover', BG, 'red/600', 'red/600'],
  ['danger/soft', '--danger-soft', BG, 'red/50', 'red/900'],
  ['danger/on', '--on-danger', TX, 'white', 'white'],
  ['success', '--success', ANY, 'green/700', 'green/300'],
  ['warning', '--warning', ANY, 'amber/700', 'amber/300'],
  ['scrim', '--scrim', BG, ['101624', 0.45], ['000000', 0.6]],
  ['loader-bg', '--loader-bg', BG, 'mist/50', 'ink/900'],
  ['stage/bg', '--stage-bg', BG, 'ink/950', 'ink/950'],
  ['stage/tile', '--stage-tile', BG, ['171b23', 1], ['171b23', 1]],
  ['stage/tile-2', '--stage-tile-2', BG, ['1f242e', 1], ['1f242e', 1]],
  ['stage/text', '--stage-text', TX, ['f2f4f8', 1], ['f2f4f8', 1]],
  ['stage/muted', '--stage-muted', TX, ['a9b2c1', 1], ['a9b2c1', 1]],
  ['stage/line', '--stage-line', LN, ['ffffff', 0.08], ['ffffff', 0.08]],
  ['stage/dock-bg', '--dock-bg', BG, ['1a1f28', 1], ['1a1f28', 1]],
  ['voice/default', '--voice', ANY, 'green/400', 'green/400'],
  ['voice/1', '--voice-1', ANY, 'green/600', 'green/600'],
  ['voice/2', '--voice-2', ANY, 'green/450', 'green/450'],
  ['voice/3', '--voice-3', ANY, 'green/400', 'green/400'],
  ['voice/4', '--voice-4', ANY, 'green/200', 'green/200'],
  ['live', '--live', BG, 'red/500', 'red/500'],
  ['live-on', '--on-live', TX, 'white', 'white'],
];
// Компонентные: псевдонимы смысловых.
const C = [
  ['component/field-bg', '--field-bg', BG, 'surface/1'],
  ['component/field-line', '--field-line', LN, 'line/strong'],
  ['component/menu-bg', '--menu-bg', BG, 'surface/3'],
  ['component/dialog-bg', '--dialog-bg', BG, 'surface/1'],
  ['component/toast-bg', '--toast-bg', BG, 'surface/3'],
  ['component/card-bg', '--card-bg', BG, 'surface/1'],
  ['component/handle', '--handle', ANY, 'accent/default'],
  ['component/brand-accent', '--brand-accent', BG, 'accent/fill'],
];
const N = [
  ...[1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16].map((k) => [
    `space/${k}`,
    `--space-${k}`,
    ['GAP'],
    [4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 64][[1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16].indexOf(k)],
  ]),
  ...[
    ['1', 4],
    ['2', 8],
    ['3', 12],
    ['4', 16],
    ['5', 20],
    ['6', 28],
    ['full', 999],
  ].map(([k, v]) => [`radius/${k}`, `--radius-${k}`, ['CORNER_RADIUS'], v]),
  ...[
    ['sm', 32],
    ['md', 36],
    ['lg', 40],
    ['touch', 48],
  ].map(([k, v]) => [`control/${k}`, `--control-${k}`, ['WIDTH_HEIGHT'], v]),
  ...[
    ['xs', 12],
    ['sm', 13],
    ['base', 14],
    ['md', 16],
    ['lg', 20],
    ['xl', 24],
    ['2xl', 32],
  ].map(([k, v]) => [`font-size/${k}`, `--text-${k}`, ['FONT_SIZE'], v]),
  ...[
    ['regular', 400],
    ['medium', 500],
    ['semibold', 600],
  ].map(([k, v]) => [`font-weight/${k}`, `--weight-${k}`, ['FONT_WEIGHT'], v]),
  ['tile/ring-width', '--tile-ring-width', ['STROKE_FLOAT'], 3],
  ['tile/radius', '--tile-radius', ['CORNER_RADIUS'], 16],
];
const M = [
  ['duration/fast', '--motion-fast', 120],
  ['duration/base', '--motion-base', 200],
  ['duration/slow', '--motion-slow', 320],
];
const E = [
  ['easing/standard', '--ease-standard', 'cubic-bezier(0.2, 0, 0, 1)'],
  ['easing/emphasized', '--ease-emphasized', 'cubic-bezier(0.05, 0.7, 0.1, 1)'],
  ['easing/exit', '--ease-exit', 'cubic-bezier(0.3, 0, 0.8, 0.15)'],
];

const rgb = (hex, a = 1) => ({
  r: parseInt(hex.slice(0, 2), 16) / 255,
  g: parseInt(hex.slice(2, 4), 16) / 255,
  b: parseInt(hex.slice(4, 6), 16) / 255,
  a,
});
const all = await figma.variables.getLocalVariablesAsync();
const cols = await figma.variables.getLocalVariableCollectionsAsync();
function collection(name, modes) {
  let c = cols.find((x) => x.name === name);
  if (!c) {
    c = figma.variables.createVariableCollection(name);
    cols.push(c);
  }
  c.renameMode(c.modes[0].modeId, modes[0]);
  for (const m of modes.slice(1)) if (!c.modes.find((x) => x.name === m)) c.addMode(m);
  return c;
}
function variable(c, name, type) {
  let v = all.find((x) => x.name === name && x.variableCollectionId === c.id);
  if (!v) {
    v = figma.variables.createVariable(name, c, type);
    all.push(v);
  }
  return v;
}
const pal = collection('Палитра', ['Значение']);
// План Starter даёт одну моду на коллекцию, поэтому темы — две коллекции с одинаковыми именами
// переменных: кадры светлой темы привязаны к «Цвет · светлая», тёмной — к «Цвет · тёмная».
const old = cols.find((x) => x.name === 'Цвет');
if (old) old.name = 'Цвет · светлая';
const themes = [collection('Цвет · светлая', ['Светлая']), collection('Цвет · тёмная', ['Тёмная'])];
const size = collection('Размеры', ['Значение']);
const motion = collection('Движение', ['Значение']);
const pv = {};
for (const [k, hex] of Object.entries(P)) {
  const v = variable(pal, k, 'COLOR');
  v.setValueForMode(pal.modes[0].modeId, rgb(hex));
  v.scopes = [];
  v.setVariableCodeSyntax('WEB', `var(--palette-${k.replace('/', '-')})`);
  pv[k] = v;
}
const val = (x) => (Array.isArray(x) ? rgb(x[0], x[1]) : { type: 'VARIABLE_ALIAS', id: pv[x].id });
themes.forEach((color, t) => {
  const mode = color.modes[0].modeId;
  const sv = {};
  for (const row of S) {
    const [name, css, scopes] = row;
    const v = variable(color, name, 'COLOR');
    v.setValueForMode(mode, val(row[3 + t]));
    v.scopes = scopes;
    v.setVariableCodeSyntax('WEB', `var(${css})`);
    sv[name] = v;
  }
  for (const [name, css, scopes, ref] of C) {
    const v = variable(color, name, 'COLOR');
    v.setValueForMode(mode, { type: 'VARIABLE_ALIAS', id: sv[ref].id });
    v.scopes = scopes;
    v.setVariableCodeSyntax('WEB', `var(${css})`);
  }
});
for (const [name, css, scopes, value] of N) {
  const v = variable(size, name, 'FLOAT');
  v.setValueForMode(size.modes[0].modeId, value);
  v.scopes = scopes;
  v.setVariableCodeSyntax('WEB', `var(${css})`);
}
for (const [name, css, value] of M) {
  const v = variable(motion, name, 'FLOAT');
  v.setValueForMode(motion.modes[0].modeId, value);
  v.scopes = [];
  v.setVariableCodeSyntax('WEB', `var(${css})`);
  v.description = 'мс; при prefers-reduced-motion — 0';
}
for (const [name, css, value] of E) {
  const v = variable(motion, name, 'STRING');
  v.setValueForMode(motion.modes[0].modeId, value);
  v.scopes = [];
  v.setVariableCodeSyntax('WEB', `var(${css})`);
}
const out = await figma.variables.getLocalVariableCollectionsAsync();
return out.map((c) => ({
  id: c.id,
  name: c.name,
  n: c.variableIds.length,
  modes: c.modes.map((m) => `${m.name}=${m.modeId}`),
}));
