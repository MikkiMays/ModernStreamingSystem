import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api/types';
import type { Meeting } from '../core/meeting';
import type { StageKind } from '../core/stage-view';
import { Store } from '../core/store';
import { useStageHotkey } from './useStageHotkey';

/*
  Клавиша выхода и возврата (R121) — G без модификаторов, как буквы плеера: только когда фокус на сцене
  или нигде, не в поле ввода и не в диалоге. Совпала с сочетанием микрофона — она его, а не наша.
*/

function fakeMeeting(room: Record<string, unknown>, micHotkey: unknown = null) {
  const stageAway = new Store<StageKind | null>(null);
  return {
    snapshot: new Store({ watch: null, poker: null, durak: null, ...room } as unknown as Snapshot),
    viewing: new Store(null),
    cinema: new Store(null),
    stageAway,
    media: { preferences: new Store({ micHotkey, overlayHotkey: null }) },
    leaveStage: vi.fn(() => stageAway.set('poker')),
    returnToStage: vi.fn(() => stageAway.set(null)),
  } as unknown as Meeting & {
    leaveStage: ReturnType<typeof vi.fn>;
    returnToStage: ReturnType<typeof vi.fn>;
  };
}

function Probe({ meeting }: { meeting: Meeting }) {
  useStageHotkey(meeting);
  return (
    <main className="stage-wrap">
      <button>на сцене</button>
      <input aria-label="поле" />
    </main>
  );
}

const press = (target: EventTarget, extra: Partial<KeyboardEventInit> = {}) =>
  act(() => {
    fireEvent.keyDown(target, { key: 'g', code: 'KeyG', ...extra });
  });

afterEach(cleanup);

describe('клавиша G', () => {
  it('сцена занята — уходит к участникам и возвращает; в русской раскладке тоже (по месту клавиши)', () => {
    const room = fakeMeeting({ poker: { seats: [] } });
    render(<Probe meeting={room} />);
    press(document.body);
    expect(room.leaveStage).toHaveBeenCalledTimes(1);
    press(document.body, { key: 'п' });
    expect(room.returnToStage).toHaveBeenCalledTimes(1);
  });

  it('в поле ввода, с модификатором, удержанием и при открытом диалоге — не наша', () => {
    const room = fakeMeeting({ poker: { seats: [] } });
    const view = render(<Probe meeting={room} />);
    press(view.getByLabelText('поле'));
    press(document.body, { ctrlKey: true });
    press(document.body, { shiftKey: true });
    press(document.body, { repeat: true });
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.append(dialog);
    press(document.body);
    dialog.remove();
    expect(room.leaveStage).not.toHaveBeenCalled();
  });

  it('сцена свободна — нечего переключать; G — сочетание микрофона — клавиша микрофона', () => {
    const quiet = fakeMeeting({});
    render(<Probe meeting={quiet} />);
    press(document.body);
    expect(quiet.leaveStage).not.toHaveBeenCalled();
    cleanup();
    const mic = fakeMeeting(
      { poker: { seats: [] } },
      { code: 'KeyG', ctrl: false, alt: false, shift: false, meta: false },
    );
    render(<Probe meeting={mic} />);
    press(document.body);
    expect(mic.leaveStage).not.toHaveBeenCalled();
  });

  it('фокус на кнопке сцены — клавиша сцены; на кнопке вне сцены — нет', () => {
    const room = fakeMeeting({ poker: { seats: [] } });
    const view = render(<Probe meeting={room} />);
    press(view.getByText('на сцене'));
    expect(room.leaveStage).toHaveBeenCalledTimes(1);
    const outside = document.createElement('button');
    document.body.append(outside);
    press(outside);
    outside.remove();
    expect(room.returnToStage).not.toHaveBeenCalled();
  });
});
