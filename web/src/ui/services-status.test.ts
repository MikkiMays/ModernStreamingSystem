import { describe, expect, it } from 'vitest';
import type { MusicState } from '../core/services';
import { gameActivity, musicActivity } from './services-status';

const music = (patch: Partial<MusicState> = {}): MusicState => ({
  roomId: 'room',
  enabled: true,
  paused: false,
  position: 0,
  revision: 1,
  status: 'playing',
  error: null,
  participantId: 'music',
  repeat: false,
  queue: [],
  ...patch,
});

describe('состояния сервисов в комнате', () => {
  it('берёт музыкальную активность из опрашиваемого MusicState', () => {
    expect(musicActivity(undefined)).toEqual({ active: false, label: 'Загружаем статус' });
    expect(musicActivity(music({ enabled: false, status: 'disabled' }))).toEqual({
      active: false,
      label: 'Выключена',
    });
    expect(musicActivity(music({ status: 'disabled' }))).toEqual({ active: false, label: 'Выключена' });
    expect(musicActivity(music({ status: 'connecting' }))).toEqual({ active: true, label: 'Подключается' });
    expect(musicActivity(music())).toEqual({ active: true, label: 'Играет' });
    expect(musicActivity(music({ status: 'paused', paused: true }))).toEqual({
      active: true,
      label: 'На паузе',
    });
    expect(musicActivity(music({ status: 'idle' }))).toEqual({ active: true, label: 'Очередь пуста' });
    expect(
      musicActivity(music({ status: 'idle', queue: [{ id: 'track' } as MusicState['queue'][number]] })),
    ).toEqual({
      active: true,
      label: 'Готова к воспроизведению',
    });
    expect(musicActivity(music({ status: 'error', error: 'Нет сети' }))).toEqual({
      active: true,
      label: 'Ошибка',
    });
    expect(musicActivity(music(), true)).toEqual({ active: false, label: 'Статус недоступен' });
  });

  it('называет каждую открытую игру и отличает лобби от партии', () => {
    expect(gameActivity(null, null)).toEqual({ active: false, label: '' });
    expect(gameActivity({ phase: 'lobby' }, { phase: 'bout' })).toEqual({
      active: true,
      label: 'Покер: лобби · Дурак: игра идёт',
    });
    expect(gameActivity({ phase: 'over' }, { phase: 'over' })).toEqual({
      active: true,
      label: 'Покер: завершён · Дурак: завершён',
    });
  });
});
