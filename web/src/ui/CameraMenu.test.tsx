import { expect, it } from 'vitest';
import stage from './stage.css?raw';

it('зум на своей плитке стоит справа внизу, а не там, где сегмент набора (R36)', () => {
  // У `.ui-segmented` своё `position: relative`: без веса двух классов пилюля уезжала в угол плитки.
  expect(stage).toMatch(/\.lens-switch\.lens-switch--zoom \{\s*position: absolute;/);
  expect(stage).toMatch(
    /\.lens-switch \{\s*position: absolute;[^}]*right: var\(--space-2\);\s*bottom: var\(--space-2\);/,
  );
});
