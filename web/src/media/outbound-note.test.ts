import { describe, expect, it } from 'vitest';
import type { OutboundVideo } from './session';
import { t } from '../i18n';
import { outboundNote } from './outbound-note';

const sending = (patch: Partial<OutboundVideo> = {}): OutboundVideo => ({
  source: 'camera',
  width: 1920,
  height: 1080,
  fps: 30,
  mbps: 6,
  limitation: 'none',
  targetFps: 30,
  dormant: false,
  settling: false,
  ...patch,
});

describe('почему уходит не то, что выбрано', () => {
  it('молчит, когда всё идёт как просили', () => {
    expect(outboundNote(t, sending())).toBe('');
  });

  it('называет кодировщик, когда жалуется он сам', () => {
    expect(outboundNote(t, sending({ limitation: 'bandwidth' }))).toBe('ограничивает канал');
    expect(outboundNote(t, sending({ limitation: 'cpu' }))).toBe('ограничивает процессор');
  });

  /** Разгон полосы в первые секунды — расписание, а не поломка: так и пишется. */
  it('в окне разгона тесноту канала называет разгоном, а не ограничением', () => {
    expect(outboundNote(t, sending({ limitation: 'bandwidth', settling: true }))).toBe('разгон канала');
    expect(outboundNote(t, sending({ limitation: 'cpu', settling: true }))).toBe('ограничивает процессор');
    expect(outboundNote(t, sending({ settling: true }))).toBe('');
  });

  /**
   * Главное свойство. Кодировщик молчит: ему принесли двадцать кадров вместо тридцати, и все
   * двадцать он отправил. Без этой ветки «выставил 30, показывает 22» не объяснялось ничем.
   */
  it('называет источник, когда кодировщик доволен, а кадров всё равно меньше', () => {
    expect(outboundNote(t, sending({ fps: 22 }))).toBe('столько даёт камера');
    expect(outboundNote(t, sending({ source: 'screen', fps: 8, targetFps: 30 }))).toBe('экран меняется реже');
  });

  it('не придирается к обычному недобору захвата', () => {
    expect(outboundNote(t, sending({ fps: 28 }))).toBe('');
    expect(outboundNote(t, sending({ fps: 0 }))).toBe('');
    expect(outboundNote(t, sending({ targetFps: 0, fps: 12 }))).toBe('');
  });

  /** Спящий слой — это отсутствие спроса, а не понижение: сказать надо именно так. */
  it('объясняет спящий слой раньше, чем придирается к частоте', () => {
    expect(outboundNote(t, sending({ dormant: true, height: 720, fps: 20 }))).toBe(
      'крупнее никто не смотрит',
    );
  });

  it('жалоба кодировщика важнее спящего слоя', () => {
    expect(outboundNote(t, sending({ dormant: true, limitation: 'cpu' }))).toBe('ограничивает процессор');
  });
});
