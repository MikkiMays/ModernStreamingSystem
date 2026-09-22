import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GarticTable as Table } from '../api/types';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import { ApiError } from '../api/client';
import GarticTable from './GarticTable';
import GarticCanvas from './GarticCanvas';

vi.mock('./GamePeople', () => ({
  GamePeople: () => <div aria-label="Участники встречи" />,
  GamePerson: ({ memberId, label }: { memberId: string; label?: string }) => (
    <span>
      {memberId}
      {label && `: ${label}`}
    </span>
  ),
}));

const player = (memberId: string, name: string) => ({
  memberId,
  name,
  score: 0,
  away: false,
  active: true,
  guessed: false,
  submitted: false,
});
const you = {
  memberId: 'self',
  playing: true,
  canDraw: false,
  canGuess: false,
  canSubmit: false,
  submitted: false,
  prompt: null,
  choices: [],
  previous: null,
};
function table(patch: Partial<Table> = {}): Table {
  return {
    gameId: 'game-1',
    hostId: 'self',
    mode: 'classic',
    phase: 'lobby',
    revision: 1,
    turnToken: 12,
    round: 1,
    rounds: 3,
    turnSeconds: 60,
    step: 0,
    totalSteps: 3,
    drawerId: null,
    deadline: 60000,
    phaseStartedAt: 0,
    players: [player('self', 'Аня'), player('other', 'Борис')],
    you,
    canvas: [],
    guesses: [],
    answer: null,
    hint: null,
    albums: [],
    revealAlbum: 0,
    revealEntry: 0,
    revealed: null,
    closesAt: 0,
    ...patch,
  };
}
function meeting(value: Table) {
  return {
    snapshot: new Store({ gartic: value, participants: [{ id: 'self', owner: false }] }),
    admission: { participantId: 'self' },
    control: { state: new Store('connected') },
    command: vi.fn().mockResolvedValue({}),
    serverNow: () => 10000,
  } as unknown as Meeting;
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pointerSupport() {
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
  Object.defineProperties(SVGElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
}

describe('Gartic private views and actions', () => {
  it('shows only the masked word to a spectator and no drawing or guessing controls', () => {
    render(
      <GarticTable
        meeting={meeting(table({ phase: 'drawing', hint: '_ _ _ _', you: null, hostId: 'other' }))}
      />,
    );
    expect(screen.getByText('_ _ _ _')).toBeVisible();
    expect(screen.getByText('Вы наблюдаете')).toBeVisible();
    expect(screen.queryByRole('textbox', { name: 'Ваша догадка' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ластик' })).not.toBeInTheDocument();
    expect(screen.queryByText('Вы рисуете')).not.toBeInTheDocument();
  });
  it('chooses a private word using the current game and phase token', async () => {
    const client = meeting(table({ phase: 'choosing', you: { ...you, choices: ['Парус', 'Луна', 'Лиса'] } }));
    render(<GarticTable meeting={client} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Луна' })));
    expect(client.command).toHaveBeenCalledWith('gartic.choose', undefined, undefined, {
      contentId: 'game-1',
      positionMs: 12,
      chips: 1,
    });
  });
  it('uses dedicated guesses and replaces a correct response with a neutral notice', async () => {
    const client = meeting(
      table({
        phase: 'drawing',
        hint: '_ _ _ _',
        you: { ...you, canGuess: true },
        guesses: [
          { id: 1, at: 100, memberId: 'other', name: 'Борис', text: 'must-not-render-answer', correct: true },
        ],
      }),
    );
    render(<GarticTable meeting={client} />);
    expect(screen.getByText('Угадал слово')).toBeVisible();
    expect(screen.queryByText('must-not-render-answer')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Ваша догадка' })).toHaveAttribute('maxlength', '80');
    fireEvent.change(screen.getByRole('textbox', { name: 'Ваша догадка' }), {
      target: { value: '  Луна  ' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Отправить догадку' })));
    expect(client.command).toHaveBeenCalledWith('gartic.guess', 'Луна', undefined, {
      contentId: 'game-1',
      positionMs: 12,
    });
  });
  it('keeps telephone assignments unavailable to spectators', () => {
    render(<GarticTable meeting={meeting(table({ mode: 'telephone', phase: 'describing', you: null }))} />);
    expect(screen.getByText('Истории пока в секрете')).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Рисунок, который нужно описать' })).not.toBeInTheDocument();
  });
  it('submits a telephone prompt with phase guards and shows only selected album entry', async () => {
    const client = meeting(table({ mode: 'telephone', phase: 'prompt', you: { ...you, canSubmit: true } }));
    const { unmount } = render(<GarticTable meeting={client} />);
    expect(screen.getByRole('textbox', { name: /Ваша фраза/ })).toHaveAttribute('maxlength', '120');
    expect(screen.getByText('0/120')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: /Ваша фраза/ }), {
      target: { value: 'Кот на Луне' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Отправить фразу' })));
    expect(client.command).toHaveBeenCalledWith('gartic.submit', 'Кот на Луне', undefined, {
      contentId: 'game-1',
      positionMs: 12,
    });
    unmount();
    const reveal = meeting(
      table({
        mode: 'telephone',
        phase: 'reveal',
        albums: [{ index: 0, ownerId: 'self', ownerName: 'Аня', entries: 3 }],
        revealed: {
          authorId: 'self',
          authorName: 'Аня',
          kind: 'text',
          text: 'Кот на Луне',
          strokes: [],
          skipped: false,
          step: 0,
        },
      }),
    );
    render(<GarticTable meeting={reveal} />);
    expect(screen.getByText('Кот на Луне')).toBeVisible();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Следующий шаг' })));
    expect(reveal.command).toHaveBeenCalledWith('gartic.reveal', undefined, undefined, {
      contentId: 'game-1',
      positionMs: 12,
      chips: 0,
      seat: 1,
    });
  });
});

it('flushes the final local stroke before submitting a telephone drawing', async () => {
  vi.useFakeTimers();
  pointerSupport();
  const client = meeting(
    table({
      mode: 'telephone',
      phase: 'drawing',
      you: { ...you, canDraw: true, canSubmit: true, prompt: 'Кот на Луне' },
    }),
  );
  let accept!: () => void;
  vi.mocked(client.command).mockImplementation((type) =>
    type === 'gartic.draw'
      ? new Promise((resolve) => {
          accept = () => resolve({} as Awaited<ReturnType<Meeting['command']>>);
        })
      : Promise.resolve({} as Awaited<ReturnType<Meeting['command']>>),
  );
  render(<GarticTable meeting={client} />);
  const canvas = screen.getByRole('img', { name: 'Холст для рисования' });
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 1000,
    height: 625,
  } as DOMRect);
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 150, clientY: 120 });
  fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 150, clientY: 120 });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Рисунок готов' }));
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(client.command).toHaveBeenCalledTimes(1);
  expect(vi.mocked(client.command).mock.calls[0]![0]).toBe('gartic.draw');
  const payload = JSON.parse(vi.mocked(client.command).mock.calls[0]![1]!);
  expect(payload.strokes[0].points).toEqual([
    [100, 160],
    [150, 192],
  ]);
  await act(async () => {
    accept();
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(vi.mocked(client.command).mock.calls[1]![0]).toBe('gartic.submit');
});

it('removes optimistic ink after a no-op retry acknowledgement following another-tab clear', async () => {
  vi.useFakeTimers();
  pointerSupport();
  const onDraw = vi.fn().mockRejectedValueOnce(new Error('Нет ответа')).mockResolvedValue(undefined);
  render(<GarticCanvas strokes={[]} editable connected onDraw={onDraw} onEdit={vi.fn()} />);
  const canvas = screen.getByRole('img', { name: 'Холст для рисования' });
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(canvas.querySelectorAll('circle')).toHaveLength(1);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Повторить отправку' }));
    await vi.advanceTimersByTimeAsync(250);
  });
  expect(onDraw).toHaveBeenCalledTimes(2);
  expect(onDraw.mock.calls[0]![0]).toBe(onDraw.mock.calls[1]![0]);
  expect(canvas.querySelectorAll('circle')).toHaveLength(0);
});

it('can clear the canvas after a definitive limit rejection without flushing the rejected batch again', async () => {
  vi.useFakeTimers();
  pointerSupport();
  const onDraw = vi.fn().mockRejectedValue(new ApiError(409, 'GARTIC_CANVAS_LIMIT', 'Рисунок заполнен'));
  const onEdit = vi.fn().mockResolvedValue(undefined);
  render(<GarticCanvas strokes={[]} editable connected onDraw={onDraw} onEdit={onEdit} />);
  const canvas = screen.getByRole('img', { name: 'Холст для рисования' });
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
  fireEvent.pointerUp(canvas, { pointerId: 1 });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('Рисунок заполнен');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Очистить рисунок' })));
  expect(onEdit).toHaveBeenCalledWith('clear');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(onDraw).toHaveBeenCalledTimes(1);
  expect(canvas.querySelectorAll('circle')).toHaveLength(0);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
