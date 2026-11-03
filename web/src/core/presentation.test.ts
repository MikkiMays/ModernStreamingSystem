import { describe, expect, it } from 'vitest';
import type { Participant } from '../api/types';
import { presentations, presentationToOpen, type Presentation } from './presentation';

/*
  Показ экрана как в Google Meet (R183): какие показы идут и какой из них открыть крупно самому.
*/

const person = (id: string, extra: Partial<Participant> = {}) =>
  ({
    id,
    name: id.toUpperCase(),
    screen: false,
    screenId: null,
    screenStarted: false,
    service: null,
    status: 'CONNECTED',
    ...extra,
  }) as Participant;
const sharing = (id: string, screenId: string, started = true) =>
  person(id, { screen: true, screenId, screenStarted: started });
const show = (screenId: string, extra: Partial<Presentation> = {}): Presentation => ({
  participantId: screenId,
  screenId,
  name: screenId,
  own: false,
  ready: true,
  ...extra,
});

describe('какие показы идут', () => {
  it('слот взят — показ есть; чужой готов, когда открыт зрителям', () => {
    expect(presentations([person('me'), sharing('a', 's1', false), sharing('b', 's2')], 'me', false)).toEqual(
      [
        { participantId: 'a', screenId: 's1', name: 'A', own: false, ready: false },
        { participantId: 'b', screenId: 's2', name: 'B', own: false, ready: true },
      ],
    );
  });

  it('свой готов, как только дорожка опубликована, — не по метке ядра', () => {
    expect(presentations([sharing('me', 's1', false)], 'me', true)).toEqual([
      { participantId: 'me', screenId: 's1', name: 'ME', own: true, ready: true },
    ]);
    expect(presentations([sharing('me', 's1', true)], 'me', false)[0]!.ready).toBe(false);
  });

  it('служебный участник и ожидающий у двери показа не дают', () => {
    expect(
      presentations(
        [
          { ...sharing('bot', 's1'), service: 'music' },
          { ...sharing('w', 's2'), status: 'WAITING' },
          person('x', { screen: true, screenId: null }),
        ],
        'me',
        false,
      ),
    ).toEqual([]);
  });
});

describe('какой показ открыть самому', () => {
  it('новый готовый показ — крупно у всех', () => {
    expect(presentationToOpen([show('s1')], new Set(), 'meeting')).toEqual({
      open: show('s1'),
      seen: ['s1'],
    });
  });

  it('один раз на показ: закрытый сам не возвращается', () => {
    expect(presentationToOpen([show('s1')], new Set(['s1']), 'meeting')).toEqual({ open: null, seen: [] });
  });

  it('пока готовится — не открывается и не замечается', () => {
    expect(presentationToOpen([show('s1', { ready: false })], new Set(), 'meeting')).toEqual({
      open: null,
      seen: [],
    });
  });

  it('интеграцию на сцене не отбирает и показ не замечает — он откроется, когда сцена освободится', () => {
    expect(presentationToOpen([show('s1')], new Set(), 'integration')).toEqual({ open: null, seen: [] });
    expect(presentationToOpen([show('s1')], new Set(), 'people').open).toEqual(show('s1'));
  });

  it('новый показ сменяет тот, что уже открыт', () => {
    expect(presentationToOpen([show('s1'), show('s2')], new Set(['s1']), 'people')).toEqual({
      open: show('s2'),
      seen: ['s2'],
    });
  });

  it('несколько новых разом — чужой важнее своего', () => {
    const own = show('mine', { own: true });
    expect(presentationToOpen([own, show('s2')], new Set(), 'meeting')).toEqual({
      open: show('s2'),
      seen: ['mine', 's2'],
    });
    expect(presentationToOpen([own], new Set(), 'meeting').open).toEqual(own);
  });
});
