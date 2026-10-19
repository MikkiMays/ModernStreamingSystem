import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../api/types';
import { allowed } from './permissions';

type View = Parameters<typeof allowed>[0];

function room(patch: Partial<Snapshot> = {}): View {
  return {
    participants: [
      { id: 'host', owner: true },
      { id: 'guest', owner: false },
    ] as Snapshot['participants'],
    integrationsAllowed: true,
    poker: null,
    durak: null,
    chess: null,
    gartic: null,
    ...patch,
  } as View;
}

describe('allowed', () => {
  it('reads the core verdict from you.can when it is there', () => {
    // T14: гость с правом на интеграции убирает музыку — так сказало ядро.
    const snapshot = room({ integrationsAllowed: false, you: { can: ['music.remove'] } });
    expect(allowed(snapshot, 'guest', 'music.remove')).toBe(true);
    // Ядро главнее флажков снимка: создателю без права в списке кнопку не показываем.
    expect(allowed(snapshot, 'host', 'room.close')).toBe(false);
  });

  it('falls back to the old rule for a core that does not send you', () => {
    const open = room();
    expect(allowed(open, 'guest', 'music.remove')).toBe(true);
    expect(allowed(open, 'guest', 'telegram.link')).toBe(false);
    expect(allowed(open, 'host', 'telegram.link')).toBe(true);
    const closed = room({ integrationsAllowed: false });
    expect(allowed(closed, 'guest', 'music.remove')).toBe(false);
    expect(allowed(closed, 'guest', 'cinema.browse')).toBe(true);
    expect(allowed(closed, 'host', 'watch.open')).toBe(true);
    expect(allowed(closed, 'stranger', 'cinema.browse')).toBe(false);
  });

  it('keeps the table host rule in the fallback', () => {
    const snapshot = room({
      integrationsAllowed: false,
      poker: { hostId: 'guest' } as Snapshot['poker'],
    });
    expect(allowed(snapshot, 'guest', 'poker.manage')).toBe(true);
    expect(allowed(snapshot, 'host', 'poker.manage')).toBe(true);
    expect(allowed(snapshot, 'guest', 'durak.manage')).toBe(false);
  });
});
