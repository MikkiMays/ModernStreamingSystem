import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Track } from 'livekit-client';
import type { Snapshot } from '../api/types';
import type { Meeting } from '../core/meeting';
import type { MediaTile } from '../media/session';
import { Store } from '../core/store';
import { Stage } from './Stage';

/*
  Показ экрана как в Google Meet (R183): крупно — экран и лента участников рядом; показ — отдельной плиткой
  в сетке; свой экран — на своей сцене своей дорожкой; «Открепить» — на самом показе.
*/

const person = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  avatar: '',
  status: 'CONNECTED',
  owner: false,
  generation: 0,
  recoveryDeadline: null,
  screen: false,
  service: null,
  ...extra,
});
const sharing = (id: string, name: string, screenId: string) =>
  person(id, name, { screen: true, screenId, screenStarted: true });

const video = (id: string, participantId: string, source: Track.Source, local = false) =>
  ({
    id,
    participantId,
    name: participantId,
    source,
    local,
    muted: false,
    track: { kind: Track.Kind.Video, attach: vi.fn(), detach: vi.fn(), on: vi.fn(), off: vi.fn() },
  }) as unknown as MediaTile;

function fakeMeeting({
  people,
  tracks = [],
  viewing = null,
}: {
  people: ReturnType<typeof person>[];
  tracks?: MediaTile[];
  viewing?: { participantId: string; screenId: string } | null;
}) {
  return {
    admission: { roomId: 'room', participantId: 'me', credential: 'token' },
    snapshot: new Store({
      participants: people,
      integrationsAllowed: true,
      watch: null,
      poker: null,
      durak: null,
    } as unknown as Snapshot),
    viewing: new Store(viewing),
    stageAway: new Store(null),
    pinnedCamera: new Store(null),
    cinema: new Store(null),
    cinemaAt: new Store(null),
    media: {
      tracks: new Store(tracks),
      speaking: new Store<string[]>([]),
      screenPreviews: new Store({}),
      videoPaused: new Store<Record<string, true>>({}),
      volumes: new Store({}),
      preferences: new Store({ layout: 'grid' }),
      levels: { watch: () => () => {}, tier: () => 0 },
      setVolume: vi.fn(),
      toggleParticipantMute: vi.fn(),
    },
    openStream: vi.fn(),
    returnToConversation: vi.fn(),
    screenPlaying: vi.fn(),
    command: vi.fn(() => Promise.resolve()),
  } as unknown as Meeting & {
    openStream: ReturnType<typeof vi.fn>;
    returnToConversation: ReturnType<typeof vi.fn>;
    screenPlaying: ReturnType<typeof vi.fn>;
  };
}

const captions = (root: ParentNode) =>
  [...root.querySelectorAll('.person-caption')].map((caption) => caption.textContent);

afterEach(cleanup);

describe('показ крупно (R183)', () => {
  it('у зрителя — экран и лента всех участников рядом, включая показывающего', () => {
    const meeting = fakeMeeting({
      people: [person('me', 'Я'), sharing('ann', 'Аня', 'S1')],
      tracks: [video('TR_scr', 'ann', Track.Source.ScreenShare)],
      viewing: { participantId: 'ann', screenId: 'S1' },
    });
    render(<Stage meeting={meeting} />);
    const stage = document.querySelector<HTMLElement>('.watch-stage')!;
    expect(stage.querySelector('.presentation-main video')).not.toBeNull();
    // Своя плитка в ленте — первой.
    expect(captions(stage.querySelector('.presentation-strip')!)).toEqual(['Я (Вы)', 'Аня']);
    expect(captions(stage.querySelector('.presentation-main')!)).toEqual(['Экран: Аня']);
  });

  it('«Открепить» на самом показе возвращает сетку', () => {
    const meeting = fakeMeeting({
      people: [person('me', 'Я'), sharing('ann', 'Аня', 'S1')],
      tracks: [video('TR_scr', 'ann', Track.Source.ScreenShare)],
      viewing: { participantId: 'ann', screenId: 'S1' },
    });
    render(<Stage meeting={meeting} />);
    fireEvent.click(screen.getByRole('button', { name: 'Открепить показ' }));
    expect(meeting.returnToConversation).toHaveBeenCalledOnce();
  });

  it('свой показ — своей дорожкой: подписи «Ваш экран», ядру «играет» не говорится', () => {
    const own = video('TR_own', 'me', Track.Source.ScreenShare, true);
    const meeting = fakeMeeting({
      people: [sharing('me', 'Я', 'MINE'), person('ann', 'Аня')],
      tracks: [own],
      viewing: { participantId: 'me', screenId: 'MINE' },
    });
    render(<Stage meeting={meeting} />);
    const main = document.querySelector<HTMLElement>('.presentation-main')!;
    expect(captions(main)).toEqual(['Ваш экран']);
    expect(own.track.attach).toHaveBeenCalled();
    fireEvent.playing(main.querySelector('video')!);
    expect(meeting.screenPlaying).not.toHaveBeenCalled();
  });

  it('второй показ — плиткой в начале ленты', () => {
    const meeting = fakeMeeting({
      people: [person('me', 'Я'), sharing('ann', 'Аня', 'S1'), sharing('bob', 'Боб', 'S2')],
      tracks: [video('TR_scr', 'ann', Track.Source.ScreenShare)],
      viewing: { participantId: 'ann', screenId: 'S1' },
    });
    render(<Stage meeting={meeting} />);
    const strip = document.querySelector<HTMLElement>('.presentation-strip')!;
    expect(captions(strip)).toEqual(['Экран: Боб', 'Я (Вы)', 'Аня', 'Боб']);
    fireEvent.click(within(strip).getByRole('button', { name: 'Закрепить показ: Боб' }));
    expect(meeting.openStream).toHaveBeenCalledWith('bob');
  });
});

describe('показ на весь экран (R187, как у Телемоста и Meet)', () => {
  const watching = () =>
    fakeMeeting({
      people: [person('me', 'Я'), sharing('ann', 'Аня', 'S1')],
      tracks: [video('TR_scr', 'ann', Track.Source.ScreenShare)],
      viewing: { participantId: 'ann', screenId: 'S1' },
    });

  it('кнопка на показе и двойной щелчок по кадру разворачивают встречу', () => {
    const toggle = vi.fn();
    render(<Stage meeting={watching()} fullscreen={{ full: false, toggle }} />);
    const main = document.querySelector<HTMLElement>('.presentation-main')!;
    fireEvent.click(within(main).getByRole('button', { name: 'Полноэкранный режим' }));
    expect(toggle).toHaveBeenCalledOnce();
    fireEvent.doubleClick(main.querySelector('.screen-viewport')!);
    expect(toggle).toHaveBeenCalledTimes(2);
    // Не развёрнуто — переключателя ленты нет: лента и так рядом.
    expect(screen.queryByRole('button', { name: 'Участники рядом с показом' })).toBeNull();
  });

  it('увеличенный кадр двигают перетаскиванием — двойной щелчок по нему не разворачивает', () => {
    const toggle = vi.fn();
    render(<Stage meeting={watching()} fullscreen={{ full: false, toggle }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Увеличить' }));
    fireEvent.doubleClick(document.querySelector('.screen-viewport')!);
    expect(toggle).not.toHaveBeenCalled();
  });

  it('в полном экране лента спрятана, пока её не вернули; «Выйти из полноэкранного режима» — на показе', () => {
    const toggle = vi.fn();
    render(<Stage meeting={watching()} fullscreen={{ full: true, toggle }} />);
    const stage = document.querySelector<HTMLElement>('.watch-stage')!;
    expect(stage).not.toHaveAttribute('data-strip');
    const people = screen.getByRole('button', { name: 'Участники рядом с показом' });
    expect(people).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(people);
    expect(stage).toHaveAttribute('data-strip', 'shown');
    expect(people).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Выйти из полноэкранного режима' }));
    expect(toggle).toHaveBeenCalledOnce();
  });
});

describe('показ — отдельная плитка в сетке (R183)', () => {
  it('открепивший видит показ первой плиткой; плитка человека — без кнопки показа', () => {
    const meeting = fakeMeeting({ people: [person('me', 'Я'), sharing('ann', 'Аня', 'S1')] });
    render(<Stage meeting={meeting} />);
    const grid = document.querySelector<HTMLElement>('.people-grid')!;
    expect(grid.getAttribute('data-count')).toBe('3');
    expect(captions(grid)).toEqual(['Экран: Аня', 'Я (Вы)', 'Аня']);
    const tiles = grid.querySelectorAll<HTMLElement>('.person-tile');
    expect(tiles[0]!.classList.contains('presentation-tile')).toBe(true);
    expect(within(tiles[2]!).queryByText('Смотреть стрим')).toBeNull();
    fireEvent.click(within(tiles[0]!).getByRole('button', { name: 'Закрепить показ: Аня' }));
    expect(meeting.openStream).toHaveBeenCalledWith('ann');
  });

  it('свой показ в сетке — живым кадром своей дорожки, нажатие — крупно', () => {
    const own = video('TR_own', 'me', Track.Source.ScreenShare, true);
    const meeting = fakeMeeting({
      people: [sharing('me', 'Я', 'MINE'), person('ann', 'Аня')],
      tracks: [own],
    });
    render(<Stage meeting={meeting} />);
    const tile = document.querySelector<HTMLElement>('.presentation-tile')!;
    expect(tile.querySelector('video')).not.toBeNull();
    expect(tile.querySelector('.screen-preview')).toBeNull();
    fireEvent.click(within(tile).getByRole('button', { name: 'Закрепить свой показ' }));
    expect(meeting.openStream).toHaveBeenCalledWith('me');
  });

  it('пока показ готовится — плитка без кнопки, со словами «Готовится показ…»', () => {
    const meeting = fakeMeeting({
      people: [
        person('me', 'Я'),
        person('ann', 'Аня', { screen: true, screenId: 'S1', screenStarted: false }),
      ],
    });
    render(<Stage meeting={meeting} />);
    const tile = document.querySelector<HTMLElement>('.presentation-tile')!;
    expect(within(tile).getByRole('status')).toHaveTextContent('Готовится показ…');
    expect(within(tile).queryByRole('button')).toBeNull();
  });
});
