import { describe, expect, it } from 'vitest';
import type { MusicState, MusicTrack } from '../core/services';
import {
  afterPromote,
  afterRemove,
  afterSkip,
  foresee,
  foresightSpent,
  formatDuration,
  offeredSources,
  playbackPosition,
  preferredSource,
} from './music-playback';

const song = (id: string): MusicTrack => ({
  id,
  title: id,
  artist: '',
  duration: 100,
  addedBy: 'Кто-то',
  source: 'upload',
});

const state = (patch: Partial<MusicState> = {}): MusicState => ({
  roomId: 'room',
  enabled: true,
  paused: false,
  position: 0,
  revision: 5,
  status: 'playing',
  error: null,
  participantId: 'bot',
  repeat: false,
  queue: [song('один'), song('два'), song('три')],
  ...patch,
});

describe('часы и очередь музыкальной панели', () => {
  it('показывает минуты и секунды и не пугается мусора', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65.7)).toBe('1:05');
    expect(formatDuration(-3)).toBe('0:00');
  });

  it('предлагает только те источники, которые есть у сервера, и в своём порядке', () => {
    expect(offeredSources(['yandex', 'upload', 'какой-то новый'])).toEqual(['upload', 'yandex']);
    expect(offeredSources(undefined)).toEqual(['upload', 'telegram', 'yandex']);
    expect(preferredSource(['upload', 'yandex'])).toBe('yandex');
    expect(preferredSource(['upload'])).toBe('upload');
    expect(preferredSource([])).toBe('upload');
  });

  /** Главное свойство предсказания: оно живёт ровно до первого состояния новее своего. */
  it('показывает нажатие до ответа и уступает первому же свежему состоянию', () => {
    const served = state({ revision: 5, paused: false });
    const foresight = { base: 5, patch: { paused: true } };
    expect(foresee(served, foresight)?.paused).toBe(true);
    expect(foresightSpent(served, foresight)).toBe(false);

    const answered = state({ revision: 6, paused: true });
    expect(foresee(answered, foresight)?.paused).toBe(true);
    expect(foresightSpent(answered, foresight)).toBe(true);
  });

  it('без предсказания и без состояния ничего не выдумывает', () => {
    expect(foresee(undefined, { base: 1, patch: { paused: true } })).toBeUndefined();
    expect(foresee(state(), null)?.paused).toBe(false);
  });

  it('двигает иглу только пока играет и не дальше конца трека', () => {
    const anchor = { position: 10, at: 1000 };
    expect(playbackPosition(anchor, 3000, true, 100)).toBe(12);
    expect(playbackPosition(anchor, 3000, false, 100)).toBe(10);
    expect(playbackPosition(anchor, 999_000, true, 100)).toBe(100);
  });

  it('при повторе «следующий» отправляет трек в конец, без повтора — убирает', () => {
    expect(afterSkip(state()).queue?.map((t) => t.id)).toEqual(['два', 'три']);
    expect(afterSkip(state({ repeat: true })).queue?.map((t) => t.id)).toEqual(['два', 'три', 'один']);
  });

  it('«следующим» ставит трек сразу за играющим, не трогая играющий', () => {
    expect(afterPromote(state(), song('три')).queue?.map((t) => t.id)).toEqual(['один', 'три', 'два']);
  });

  it('обнуляет позицию, только если убрали именно тот трек, что играет', () => {
    expect(afterRemove(state({ position: 42 }), 'два').position).toBe(42);
    expect(afterRemove(state({ position: 42 }), 'один').position).toBe(0);
  });
});
