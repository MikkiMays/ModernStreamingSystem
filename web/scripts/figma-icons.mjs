#!/usr/bin/env node
// Значки lucide, которыми пользуется Cord, — в SVG 24×24 для компонентов «Значок/…» в Figma (E15-B).
// Пишет ../backlog/screens/figma/icons/<имя>.svg; выгрузка — figma-svg-upload.mjs.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const NAMES = (
  process.argv[2] ??
  'plus,arrow-right,arrow-left,x,check,chevron-down,chevron-right,mic,mic-off,video,video-off,monitor-up,phone-off,settings,sliders-horizontal,ellipsis,star,users,message-square,link,copy,info,triangle-alert,shield-alert,timer-off,music,clapperboard,gamepad-2,picture-in-picture-2,download,log-out,search,paperclip,hand,layout-grid,headphones'
).split(',');
const out = path.resolve('../backlog/screens/figma/icons');
mkdirSync(out, { recursive: true });
const dir = path.dirname(require.resolve('lucide-react/dist/esm/icons/plus.js'));
for (const name of NAMES) {
  const src = readFileSync(path.join(dir, `${name}.js`), 'utf8');
  const node = /const __iconNode = (\[[\s\S]*?\]);\n/.exec(src)?.[1];
  if (!node) {
    console.log(`✗ ${name}`);
    continue;
  }
  const items = Function(`return ${node}`)();
  const body = items
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .filter(([k]) => k !== 'key')
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ')}/>`,
    )
    .join('');
  writeFileSync(
    path.join(out, `${name}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1b1f27" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`,
  );
}
console.log(NAMES.length, out);
