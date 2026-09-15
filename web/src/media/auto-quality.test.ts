import { describe, expect, it } from 'vitest';
import { AutoQuality, ladder, startingRung } from './auto-quality';

const target = 6_000_000;
const plenty = target * 3;

describe('automatic quality', () => {
  it('holds the level while nothing is limiting it and headroom is unknown', () => {
    const quality = new AutoQuality();
    for (let i = 0; i < 10; i++) expect(quality.observe('none', null, target)).toBeNull();
    expect(quality.current).toEqual(ladder[startingRung]);
  });

  it('needs sustained pressure before dropping, so one bad sample is ignored', () => {
    const quality = new AutoQuality();
    expect(quality.observe('bandwidth', null, target)).toBeNull();
    expect(quality.current).toEqual(ladder[startingRung]);
    expect(quality.observe('bandwidth', null, target)).toEqual(ladder[startingRung - 1]);
  });

  it('forgets earlier pressure once the link recovers', () => {
    const quality = new AutoQuality();
    expect(quality.observe('bandwidth', null, target)).toBeNull();
    expect(quality.observe('none', null, target)).toBeNull();
    expect(quality.observe('bandwidth', null, target)).toBeNull();
    expect(quality.current).toEqual(ladder[startingRung]);
  });

  it('climbs only after sustained headroom above the current target', () => {
    const quality = new AutoQuality();
    for (let i = 0; i < 4; i++) expect(quality.observe('none', plenty, target)).toBeNull();
    expect(quality.observe('none', plenty, target)).toEqual(ladder[startingRung + 1]);
  });

  it('does not climb on bandwidth that merely matches the current target', () => {
    const quality = new AutoQuality();
    for (let i = 0; i < 12; i++) expect(quality.observe('none', target, target)).toBeNull();
    expect(quality.current).toEqual(ladder[startingRung]);
  });

  it('stops at the ends of the ladder', () => {
    const top = new AutoQuality(ladder.length - 1);
    for (let i = 0; i < 12; i++) expect(top.observe('none', plenty, target)).toBeNull();
    expect(top.current).toEqual(ladder[ladder.length - 1]);

    const bottom = new AutoQuality(0);
    for (let i = 0; i < 12; i++) expect(bottom.observe('bandwidth', null, target)).toBeNull();
    expect(bottom.current).toEqual(ladder[0]);
  });

  it('treats an overloaded encoder the same as a saturated link', () => {
    const quality = new AutoQuality();
    quality.observe('cpu', plenty, target);
    expect(quality.observe('cpu', plenty, target)).toEqual(ladder[startingRung - 1]);
  });

  it('walks the whole ladder down and back up', () => {
    const quality = new AutoQuality(ladder.length - 1);
    for (let step = ladder.length - 1; step > 0; step--) {
      quality.observe('bandwidth', null, target);
      expect(quality.observe('bandwidth', null, target)).toEqual(ladder[step - 1]);
    }
    expect(quality.current).toEqual(ladder[0]);
    for (let step = 0; step < ladder.length - 1; step++) {
      for (let i = 0; i < 4; i++) quality.observe('none', plenty, target);
      expect(quality.observe('none', plenty, target)).toEqual(ladder[step + 1]);
    }
    expect(quality.current).toEqual(ladder[ladder.length - 1]);
  });

  it('clamps a nonsense starting point', () => {
    expect(new AutoQuality(-5).current).toEqual(ladder[0]);
    expect(new AutoQuality(99).current).toEqual(ladder[ladder.length - 1]);
  });
});
