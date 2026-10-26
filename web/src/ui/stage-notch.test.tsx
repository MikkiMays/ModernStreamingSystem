import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api/types';
import type { Meeting } from '../core/meeting';
import type { StageKind } from '../core/stage-view';
import { Store } from '../core/store';
import { theaterVideo } from './cinema/theater/live-frame';
import { StageNotch } from './StageNotch';

/*
  Чёлка (R121): пока интеграция идёт, а зритель смотрит людей, сверху по центру — что идёт и как, и
  возврат одним нажатием. В интеграции и в обычной встрече её нет.
*/

const seats = (...members: (string | null)[]) => members.map((memberId, index) => ({ index, memberId }));

function fakeMeeting(room: Record<string, unknown>, away: StageKind | null = null) {
  const stageAway = new Store<StageKind | null>(away);
  return {
    admission: { roomId: 'room', participantId: 'me', credential: 'token' },
    snapshot: new Store({
      participants: [],
      watch: null,
      poker: null,
      durak: null,
      chess: null,
      gartic: null,
      ...room,
    } as unknown as Snapshot),
    viewing: new Store(null),
    cinema: new Store(null),
    stageAway,
    serverNow: () => 0,
    returnToStage: vi.fn(() => stageAway.set(null)),
  } as unknown as Meeting & { stageAway: Store<StageKind | null>; returnToStage: ReturnType<typeof vi.fn> };
}

const poker = { seats: seats('me', 'ann', 'bob'), you: null, paused: false, actionAt: 1000, deadline: 46000 };

afterEach(() => {
  cleanup();
  theaterVideo.set(null);
  vi.restoreAllMocks();
});

describe('чёлка', () => {
  it('сцена свободна или зритель в интеграции — чёлки нет', () => {
    const { container } = render(<StageNotch meeting={fakeMeeting({})} />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    const inside = render(<StageNotch meeting={fakeMeeting({ poker })} />);
    expect(inside.container).toBeEmptyDOMElement();
  });

  it('ушёл от стола — имя и состояние одной строкой; нажатие возвращает', () => {
    const room = fakeMeeting({ poker }, 'poker');
    render(<StageNotch meeting={room} />);
    const notch = screen.getByRole('button', { name: 'Вернуться: Покер — 3 за столом' });
    expect(notch).toHaveTextContent('Покер');
    expect(notch).toHaveTextContent('3 за столом');
    expect(notch).toHaveAttribute('aria-keyshortcuts', 'G');
    expect(notch).toHaveAttribute('data-stage-notch');
    fireEvent.click(notch);
    expect(room.returnToStage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('ход за ушедшим — «Ваш ход» и кольцо хода вокруг знака, без мигания', () => {
    render(<StageNotch meeting={fakeMeeting({ poker: { ...poker, you: { turn: true } } }, 'poker')} />);
    const notch = screen.getByRole('button', { name: 'Вернуться: Покер — Ваш ход' });
    expect(notch).toHaveAttribute('data-turn', 'true');
    expect(notch.querySelector('.turn-ring')).not.toBeNull();
  });

  it('фильм — живой кадр и время своего плеера, пауза — словами для диктора', () => {
    // У jsdom нет холста: рисовать кадр здесь нечем, проверяется, что холст на месте.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 4360 });
    Object.defineProperty(video, 'readyState', { configurable: true, value: 4 });
    act(() => theaterVideo.set(video));
    const watch = { title: 'Дюна', paused: true, kind: 'video', positionMs: 0, anchorAt: 0 };
    const { container } = render(<StageNotch meeting={fakeMeeting({ watch }, 'cinema')} />);
    expect(
      screen.getByRole('button', { name: 'Вернуться: Кинозал — Дюна, 1:12:40, на паузе' }),
    ).toBeVisible();
    expect(container.querySelector('canvas.stage-notch__frame')).not.toBeNull();
  });
});
