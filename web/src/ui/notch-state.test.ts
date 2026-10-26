import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../api/types';
import { t } from '../i18n';
import { notchState } from './notch-state';

/*
  Чёлка (R121): одна строка о том, что идёт на сцене, пока зритель смотрит людей. Имя интеграции и живое
  состояние — сколько за столом, чей ход, что и с какой секунды смотрят. «Ваш ход» — заметно (`turn`), с
  кольцом хода от меток ядра, но только когда ход правда за этим зрителем и стол не на паузе.
*/

const room = (extra: Record<string, unknown>) =>
  ({ chess: null, gartic: null, poker: null, durak: null, watch: null, ...extra }) as unknown as Snapshot;
const seats = (...members: (string | null)[]) => members.map((memberId, index) => ({ index, memberId }));

describe('столы', () => {
  it('покер: сколько за столом; ход у меня — «Ваш ход» с кольцом хода', () => {
    const poker = {
      seats: seats('me', 'ann', 'bob', null),
      you: null,
      paused: false,
      actionAt: 1,
      deadline: 9,
    };
    expect(notchState(t, room({ poker }), 'me', 0)).toMatchObject({
      kind: 'poker',
      name: 'Покер',
      status: '3 за столом',
      turn: false,
    });
    const mine = notchState(t, room({ poker: { ...poker, you: { turn: true } } }), 'me', 0);
    expect(mine).toMatchObject({ status: 'Ваш ход', turn: true, ring: { actionAt: 1, deadline: 9 } });
    // Стол на паузе — часы стоят, торопить нечем.
    const paused = notchState(t, room({ poker: { ...poker, paused: true, you: { turn: true } } }), 'me', 0);
    expect(paused).toMatchObject({ status: '3 за столом', turn: false });
    expect(paused?.ring).toBeUndefined();
  });

  it('дурак: ход у меня в бою — «Ваш ход»; между боями — сколько за столом', () => {
    const durak = {
      seats: seats('me', 'ann'),
      you: { turn: true },
      phase: 'bout',
      paused: false,
      actionAt: 5,
      deadline: 35,
    };
    expect(notchState(t, room({ durak }), 'me', 0)).toMatchObject({
      kind: 'durak',
      name: 'Дурак',
      status: 'Ваш ход',
      turn: true,
      ring: { actionAt: 5, deadline: 35 },
    });
    expect(notchState(t, room({ durak: { ...durak, phase: 'lobby' } }), 'me', 0)).toMatchObject({
      status: '2 за столом',
      turn: false,
    });
  });

  it('шахматы: мой цвет ходит — «Ваш ход» без кольца (у шахмат свои часы)', () => {
    const chess = {
      phase: 'playing',
      turn: 'black',
      white: { memberId: 'ann' },
      black: { memberId: 'me' },
    };
    const mine = notchState(t, room({ chess }), 'me', 0);
    expect(mine).toMatchObject({ kind: 'chess', name: 'Шахматы', status: 'Ваш ход', turn: true });
    expect(mine?.ring).toBeUndefined();
    expect(notchState(t, room({ chess: { ...chess, turn: 'white' } }), 'me', 0)).toMatchObject({
      status: '2 за столом',
      turn: false,
    });
  });

  it('рисование: кто рисует — по имени; рисую я — «Вы рисуете»', () => {
    const gartic = {
      phase: 'drawing',
      drawerId: 'ann',
      players: [
        { memberId: 'me', name: 'Я' },
        { memberId: 'ann', name: 'Аня' },
      ],
      you: { playing: true, submitted: false },
      phaseStartedAt: 3,
      deadline: 63,
    };
    expect(notchState(t, room({ gartic }), 'me', 0)).toMatchObject({
      kind: 'gartic',
      name: 'Gartic',
      status: 'Рисует Аня',
      turn: false,
    });
    expect(notchState(t, room({ gartic: { ...gartic, drawerId: 'me' } }), 'me', 0)).toMatchObject({
      status: 'Вы рисуете',
      turn: true,
      ring: { actionAt: 3, deadline: 63 },
    });
    expect(
      notchState(t, room({ gartic: { ...gartic, phase: 'lobby', drawerId: null } }), 'me', 0),
    ).toMatchObject({ status: '2 за столом', turn: false });
  });
});

describe('пустой стол', () => {
  it('за столом никого — без «0 за столом»: только имя', () => {
    const chess = { phase: 'lobby', turn: 'white', white: null, black: null };
    expect(notchState(t, room({ chess }), 'me', 0)).toMatchObject({ name: 'Шахматы', status: '' });
    expect(notchState(t, room({ poker: { seats: seats(null, null), you: null } }), 'me', 0)?.status).toBe('');
  });
});

describe('кинозал', () => {
  const watch = { title: 'Дюна', paused: false, kind: 'video' };

  it('фильм — название и время; на паузе — отметка паузы', () => {
    expect(notchState(t, room({ watch }), 'me', 4_360_000)).toMatchObject({
      kind: 'cinema',
      name: 'Дюна',
      status: '1:12:40',
      paused: false,
      live: false,
      film: true,
    });
    expect(notchState(t, room({ watch: { ...watch, paused: true } }), 'me', 65_000)).toMatchObject({
      status: '1:05',
      paused: true,
    });
  });

  it('эфир — LIVE вместо времени; без названия — словом «Кинозал»', () => {
    expect(notchState(t, room({ watch: { ...watch, kind: 'channel' } }), 'me', 1000)).toMatchObject({
      status: 'LIVE',
      live: true,
    });
    expect(notchState(t, room({ watch: { ...watch, title: null } }), 'me', 0)?.name).toBe('Кинозал');
  });

  it('только свой каталог — «Кинозал · Каталог», без кадра', () => {
    expect(notchState(t, room({}), 'me', 0, true)).toMatchObject({
      kind: 'cinema',
      name: 'Кинозал',
      status: 'Каталог',
      film: false,
    });
  });

  it('сцена свободна — чёлки нет', () => {
    expect(notchState(t, room({}), 'me', 0)).toBeNull();
  });
});
