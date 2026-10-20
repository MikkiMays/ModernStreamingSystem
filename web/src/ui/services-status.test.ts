import { describe, expect, it } from 'vitest';
import type { MusicState } from '../core/services';
import { t } from '../i18n';
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
    expect(musicActivity(t, undefined)).toEqual({ active: false, label: 'Загружаем статус' });
    expect(musicActivity(t, music({ enabled: false, status: 'disabled' }))).toEqual({
      active: false,
      label: 'Выключена',
    });
    expect(musicActivity(t, music({ status: 'disabled' }))).toEqual({ active: false, label: 'Выключена' });
    expect(musicActivity(t, music({ status: 'connecting' }))).toEqual({
      active: true,
      label: 'Подключается',
    });
    expect(musicActivity(t, music())).toEqual({ active: true, label: 'Играет' });
    expect(musicActivity(t, music({ status: 'paused', paused: true }))).toEqual({
      active: true,
      label: 'На паузе',
    });
    expect(musicActivity(t, music({ status: 'idle' }))).toEqual({ active: true, label: 'Очередь пуста' });
    expect(
      musicActivity(t, music({ status: 'idle', queue: [{ id: 'track' } as MusicState['queue'][number]] })),
    ).toEqual({
      active: true,
      label: 'Готова к воспроизведению',
    });
    expect(musicActivity(t, music({ status: 'error', error: 'Нет сети' }))).toEqual({
      active: true,
      label: 'Ошибка',
    });
    expect(musicActivity(t, music(), true)).toEqual({ active: false, label: 'Статус недоступен' });
  });

  it('называет каждую открытую игру и отличает лобби от партии', () => {
    expect(gameActivity(t, null, null)).toEqual({ active: false, label: '' });
    expect(gameActivity(t, { phase: 'lobby' }, { phase: 'bout' })).toEqual({
      active: true,
      label: 'Покер: лобби · Дурак: игра идёт',
    });
    expect(gameActivity(t, { phase: 'over' }, { phase: 'over' })).toEqual({
      active: true,
      label: 'Покер: завершён · Дурак: завершён',
    });
  });
});
