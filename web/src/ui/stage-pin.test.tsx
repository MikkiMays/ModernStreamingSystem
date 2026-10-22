import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '../api/types';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import { Stage } from './Stage';

/*
  Закрепление камеры (R83, R84). Раньше в сетке закрепление ставило только рамку `inset`, которую
  кадр камеры закрывал целиком: снаружи не менялось ничего, а в меню так и оставалось «Закрепить».
  Теперь закреплённый — крупно над лентой остальных, у него кнопка «Открепить», и в меню пункт
  переключается. «Говорящий» — та же раскладка, крупно тот, кто говорит.
*/

const person = (id: string, name: string) => ({
  id,
  name,
  avatar: '',
  status: 'CONNECTED',
  owner: false,
  generation: 0,
  recoveryDeadline: null,
  screen: false,
  service: null,
});

function fakeMeeting(layout: 'grid' | 'speaker' = 'grid', pinned: string | null = null) {
  const pinnedCamera = new Store<string | null>(pinned);
  return {
    admission: { roomId: 'room', participantId: 'me', credential: 'token' },
    snapshot: new Store({
      participants: [person('me', 'Я'), person('ann', 'Аня'), person('misha', 'Миша')],
      integrationsAllowed: true,
      watch: null,
      poker: null,
      durak: null,
    } as unknown as Snapshot),
    viewing: new Store(null),
    pinnedCamera,
    cinema: new Store(null),
    cinemaAt: new Store(null),
    media: {
      tracks: new Store([]),
      speaking: new Store<string[]>([]),
      screenPreviews: new Store({}),
      volumes: new Store({}),
      preferences: new Store({ layout }),
      levels: { watch: () => () => {}, tier: () => 0 },
      setVolume: vi.fn(),
      toggleParticipantMute: vi.fn(),
    },
    pinCamera: vi.fn((id: string) => pinnedCamera.set(id)),
    unpinCamera: vi.fn(() => pinnedCamera.set(null)),
    openStream: vi.fn(),
    command: vi.fn(() => Promise.resolve()),
  } as unknown as Meeting & {
    pinCamera: ReturnType<typeof vi.fn>;
    unpinCamera: ReturnType<typeof vi.fn>;
    pinnedCamera: Store<string | null>;
  };
}

const tileOf = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('.person-tile')].find((tile) =>
    tile.querySelector('.person-caption')?.textContent?.startsWith(name),
  )!;

afterEach(cleanup);

describe('закреплённая камера', () => {
  it('крупно над лентой остальных, с меткой и кнопкой «Открепить»', () => {
    const meeting = fakeMeeting('grid', 'ann');
    render(<Stage meeting={meeting} />);
    const stage = document.querySelector('.conversation-stage')!;
    expect(stage.getAttribute('data-spotlight')).toBe('true');
    const main = stage.querySelector('.spotlight-main')!;
    expect(main.querySelectorAll('.person-tile')).toHaveLength(1);
    expect(tileOf('Аня').closest('.spotlight-main')).toBe(main);
    expect(tileOf('Аня').getAttribute('data-pinned')).toBe('true');
    // Лента: своя плитка первой, как в Discord на телефоне.
    const strip = stage.querySelector('.spotlight-strip')!;
    expect([...strip.querySelectorAll('.person-caption')].map((caption) => caption.textContent)).toEqual([
      'Я (Вы)',
      'Миша',
    ]);
    fireEvent.click(within(tileOf('Аня')).getByRole('button', { name: 'Открепить: Аня' }));
    expect(meeting.unpinCamera).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.conversation-stage')!.getAttribute('data-spotlight')).toBeNull();
    expect(document.querySelectorAll('.people-grid .person-tile')).toHaveLength(3);
  });

  it('свою камеру тоже закрепляют', () => {
    render(<Stage meeting={fakeMeeting('grid', 'me')} />);
    expect(tileOf('Я').closest('.spotlight-main')).not.toBeNull();
    expect(within(tileOf('Я')).getByRole('button', { name: 'Открепить: Я' })).toBeVisible();
  });

  it('в меню плитки — «Закрепить камеру», у закреплённой — «Открепить камеру»', async () => {
    const meeting = fakeMeeting();
    render(<Stage meeting={meeting} />);
    fireEvent.click(within(tileOf('Аня')).getByRole('button', { name: 'Действия: Аня' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Закрепить камеру' }));
    expect(meeting.pinCamera).toHaveBeenCalledWith('ann');
    await act(async () => {});
    fireEvent.click(within(tileOf('Аня')).getByRole('button', { name: 'Действия: Аня' }));
    expect(await screen.findByRole('menuitem', { name: 'Открепить камеру' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Закрепить камеру' })).toBeNull();
  });
});

describe('«Говорящий»', () => {
  it('та же раскладка: крупно говорящий, без «Открепить»', () => {
    const meeting = fakeMeeting('speaker');
    (meeting.media.speaking as Store<string[]>).set(['misha']);
    render(<Stage meeting={meeting} />);
    expect(tileOf('Миша').closest('.spotlight-main')).not.toBeNull();
    expect(tileOf('Миша').getAttribute('data-focused')).toBe('true');
    expect(screen.queryByRole('button', { name: /^Открепить/ })).toBeNull();
    expect(document.querySelector('.stage')!.getAttribute('data-layout')).toBe('speaker');
  });

  it('один во встрече — сетка из одной плитки, ленты нет', () => {
    const meeting = fakeMeeting('speaker');
    (meeting.snapshot as Store<Snapshot>).set({
      ...meeting.snapshot.get(),
      participants: [person('me', 'Я')] as unknown as Snapshot['participants'],
    });
    render(<Stage meeting={meeting} />);
    expect(document.querySelector('.spotlight-strip')).toBeNull();
    expect(document.querySelectorAll('.person-tile')).toHaveLength(1);
  });
});
