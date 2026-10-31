// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { Store } from '../core/store';
import type { Meeting } from '../core/meeting';
import { shareRequests, useDesktopOverlay } from './useDesktopOverlay';

/*
  Встреча для окон оболочки поверх других программ (R63, R93, R104): состав и уровни — виджету в
  игре, состояние — мини-окну, нажатия мини-окна и «Показать игру» — встрече. Оболочка до R63 получает
  прежнее `overlay.state`.
*/

function fakeDesktop(features: string[]) {
  const listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
  const api = {
    protocol: { major: 2, minor: 0 },
    features,
    app: { version: '1.0.8', arch: 'x64' },
    bootstrap: {
      profile: 'x'.repeat(43),
      theme: 'system',
      language: null,
      showPing: false,
      notificationSounds: true,
      autoConnect: true,
    },
    send: vi.fn(),
    invoke: vi.fn(async () => ({ ok: true })),
    on: vi.fn((type: string, listener: (data: Record<string, unknown>) => void) => {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
      return () => void set?.delete(listener);
    }),
    emit(type: string, data: Record<string, unknown> = {}) {
      for (const listener of listeners.get(type) ?? []) listener(data);
    },
  };
  (window as unknown as { cordDesktop?: unknown }).cordDesktop = api;
  return api;
}

function fakeMeeting() {
  const person = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    avatar: '',
    service: null,
    status: 'CONNECTED',
    ...extra,
  });
  const levels = new Store<Record<string, { tier: number; level: number }>>({
    'p-2': { tier: 3, level: 0.6 },
  });
  const meeting = {
    admission: { participantId: 'p-1', snapshot: { title: 'Пятница' } },
    snapshot: new Store({
      participants: [
        person('p-1', 'Аня'),
        person('p-2', 'Миша', { avatar: 'data:image/png;base64,AAAA' }),
        person('bot', 'Музыка', { service: 'music' }),
        person('p-3', 'Ждёт', { status: 'WAITING' }),
      ],
    }),
    unread: new Store(2),
    ended: new Store(false),
    media: {
      state: new Store({ status: 'connected', microphone: true, camera: false, screen: false }),
      deafened: new Store(false),
      setDeafened: vi.fn(async (_value: boolean) => {}),
      tracks: new Store([{ participantId: 'p-2', source: 'microphone', muted: false }]),
      speaking: new Store<string[]>([]),
      levels: { state: levels, watchAll: (listener: () => void) => levels.subscribe(listener) },
      preferences: new Store({ screen: { resolution: 1080, fps: 30, mode: 'sharp', audio: 'system' } }),
      toggle: vi.fn(async () => {}),
      setMicrophone: vi.fn(async () => {}),
      stopScreen: vi.fn(async () => {}),
      share: vi.fn(),
    },
  };
  return { meeting, levels };
}

const actions = () => ({ setPanel: vi.fn(), openSettings: vi.fn(), leave: vi.fn() });
const sent = (api: ReturnType<typeof fakeDesktop>, type: string) =>
  api.send.mock.calls.filter(([name]) => name === type).map(([, payload]) => payload);

afterEach(() => {
  cleanup();
  delete (window as unknown as { cordDesktop?: unknown }).cordDesktop;
});

describe('окна оболочки поверх других программ (R63, R93)', () => {
  it('состав — люди встречи без ботов и ждущих, с аватаром data: и выключенным микрофоном; уровни — сразу', () => {
    const api = fakeDesktop(['overlay', 'overlay.widget', 'mini']);
    const { meeting, levels } = fakeMeeting();
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    expect(sent(api, 'overlay.roster').at(-1)).toEqual({
      participants: [
        { id: 'p-1', name: 'Аня', avatar: '', muted: false },
        { id: 'p-2', name: 'Миша', avatar: 'data:image/png;base64,AAAA', muted: false },
      ],
    });
    expect(sent(api, 'overlay.levels').at(-1)).toEqual({ levels: [['p-2', 3, 0.6]] });
    // Уровень сменился — уходит сразу, без дросселя 100 мс.
    act(() => levels.set({ 'p-1': { tier: 1, level: 0.2 } }));
    expect(sent(api, 'overlay.levels').at(-1)).toEqual({ levels: [['p-1', 1, 0.2]] });
    // Свой микрофон выключили — состав уходит заново.
    act(() => meeting.media.state.set({ ...meeting.media.state.get(), microphone: false }));
    expect(sent(api, 'overlay.roster').at(-1)).toMatchObject({
      participants: [{ id: 'p-1', muted: true }, { id: 'p-2' }],
    });
    expect(sent(api, 'overlay.state')).toEqual([]);
  });

  it('участник без аватара (ядро шлёт null) — состав уходит с пустым аватаром, встреча не падает', () => {
    const api = fakeDesktop(['overlay', 'overlay.widget', 'mini']);
    const { meeting } = fakeMeeting();
    meeting.snapshot.set({
      participants: meeting.snapshot
        .get()
        .participants.map((p) => (p.id === 'p-1' ? { ...p, avatar: null } : p)),
    } as never);
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    expect(sent(api, 'overlay.roster').at(-1)).toMatchObject({
      participants: [
        { id: 'p-1', avatar: '' },
        { id: 'p-2', avatar: 'data:image/png;base64,AAAA' },
      ],
    });
  });

  it('мини-окно: состояние встречи сразу, как поменялось, и без повторов; номер растёт с каждым изменением', () => {
    const api = fakeDesktop(['overlay', 'mini']);
    const { meeting } = fakeMeeting();
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    expect(sent(api, 'mini.state')).toEqual([
      {
        room: 'Пятница',
        self: 'p-1',
        mic: true,
        deafened: false,
        camera: false,
        screen: false,
        unread: 2,
        count: 2,
        status: 'connected',
        remaining: 0,
        seq: 1,
      },
    ]);
    act(() => meeting.unread.set(3));
    act(() => meeting.unread.set(3));
    expect(sent(api, 'mini.state')).toHaveLength(2);
    expect(sent(api, 'mini.state').at(-1)).toMatchObject({ unread: 3, seq: 2 });
  });

  it('R137: состояние повторяется раз в 5 с с тем же номером и сразу по mini.resync — вместе с составом', () => {
    vi.useFakeTimers();
    try {
      const api = fakeDesktop(['overlay', 'overlay.widget', 'mini']);
      const { meeting } = fakeMeeting();
      renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
      expect(sent(api, 'mini.state')).toHaveLength(1);
      act(() => void vi.advanceTimersByTime(4900));
      expect(sent(api, 'mini.state'), 'раньше 5 с — не повторяется').toHaveLength(1);
      act(() => void vi.advanceTimersByTime(200));
      expect(sent(api, 'mini.state')).toHaveLength(2);
      expect(sent(api, 'mini.state').at(-1)).toEqual(sent(api, 'mini.state')[0]);
      const rosters = sent(api, 'overlay.roster').length;
      act(() => api.emit('mini.resync'));
      expect(sent(api, 'mini.state')).toHaveLength(3);
      expect(sent(api, 'mini.state').at(-1)).toMatchObject({ seq: 1 });
      expect(sent(api, 'overlay.roster'), 'состав — тоже заново').toHaveLength(rosters + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('мини-окно знает о восстановлении связи: состояние и секунды; нажатия до связи не исполняются', () => {
    const api = fakeDesktop(['overlay', 'mini']);
    const { meeting } = fakeMeeting();
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    const connected = meeting.media.state.get();
    act(() =>
      meeting.media.state.set({ ...connected, status: 'recovering', remaining: 17.2 } as typeof connected),
    );
    expect(sent(api, 'mini.state').at(-1)).toMatchObject({ status: 'recovering', remaining: 18 });
    api.emit('mini.action', { id: 'mic' });
    api.emit('mini.action', { id: 'camera' });
    expect(meeting.media.toggle).not.toHaveBeenCalled();
    act(() => meeting.media.state.set(connected));
    expect(sent(api, 'mini.state').at(-1)).toMatchObject({ status: 'connected', remaining: 0 });
    api.emit('mini.action', { id: 'mic' });
    expect(meeting.media.toggle).toHaveBeenCalledWith('microphone');
  });

  it('нажатия мини-окна: микрофон и камера — встреча, участники и чат — панель, показ — окно выбора пульта', () => {
    const api = fakeDesktop(['overlay', 'mini']);
    const { meeting } = fakeMeeting();
    const handlers = actions();
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, handlers));
    api.emit('mini.action', { id: 'mic' });
    api.emit('mini.action', { id: 'camera' });
    expect(meeting.media.toggle).toHaveBeenCalledWith('microphone');
    expect(meeting.media.toggle).toHaveBeenCalledWith('camera');
    api.emit('mini.action', { id: 'chat' });
    expect(handlers.setPanel).toHaveBeenCalledWith('chat');
    api.emit('mini.action', { id: 'settings' });
    expect(handlers.openSettings).toHaveBeenCalled();
    const before = shareRequests.get();
    api.emit('mini.action', { id: 'screen' });
    expect(shareRequests.get()).toBe(before + 1);
    meeting.media.state.set({ ...meeting.media.state.get(), screen: true });
    api.emit('mini.action', { id: 'screen' });
    expect(meeting.media.stopScreen).toHaveBeenCalled();
    api.emit('mini.action', { id: 'leave' });
    expect(handlers.leave).toHaveBeenCalled();
  });

  it('R137: нажатие с нужным состоянием — микрофон ставится, а не переключается; ответ mini.ack с номером', async () => {
    const api = fakeDesktop(['overlay', 'mini']);
    const { meeting } = fakeMeeting();
    meeting.media.setMicrophone.mockImplementation(async (...args: unknown[]) => {
      const on = args[0] as boolean;
      meeting.media.state.set({ ...meeting.media.state.get(), microphone: on });
    });
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    api.emit('mini.action', { id: 'mic', want: false, seq: 7 });
    await act(async () => {});
    expect(meeting.media.setMicrophone).toHaveBeenCalledWith(false);
    expect(meeting.media.toggle).not.toHaveBeenCalled();
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 7, result: 'ok' });
    // То же нажатие ещё раз (мини-окно не успело увидеть новое состояние) — уже так, ничего не делается.
    api.emit('mini.action', { id: 'mic', want: false, seq: 8 });
    await act(async () => {});
    expect(meeting.media.setMicrophone).toHaveBeenCalledTimes(1);
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 8, result: 'ok' });
  });

  it('R137: микрофон не встал (нет доступа) — mini.ack ignored, мини-окно перестаёт ждать', async () => {
    const api = fakeDesktop(['overlay', 'mini']);
    const { meeting } = fakeMeeting();
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    api.emit('mini.action', { id: 'mic', want: false, seq: 3 });
    await act(async () => {});
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 3, result: 'ignored', reason: 'failed' });
  });

  it('R137: камера — нужное состояние; уже так — без переключения; не переключилась (занята) — ignored busy', async () => {
    const api = fakeDesktop(['overlay', 'mini']);
    const { meeting } = fakeMeeting();
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    api.emit('mini.action', { id: 'camera', want: false, seq: 1 });
    await act(async () => {});
    expect(meeting.media.toggle).not.toHaveBeenCalled();
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 1, result: 'ok' });
    api.emit('mini.action', { id: 'camera', want: true, seq: 2 });
    await act(async () => {});
    expect(meeting.media.toggle).toHaveBeenCalledWith('camera');
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 2, result: 'ignored', reason: 'busy' });
    meeting.media.toggle.mockImplementation(async () => {
      meeting.media.state.set({ ...meeting.media.state.get(), camera: true });
    });
    api.emit('mini.action', { id: 'camera', want: true, seq: 3 });
    await act(async () => {});
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 3, result: 'ok' });
  });

  it('R137: без связи — ignored link; показ: «остановить» при показе останавливает, «начать» при показе — уже так', async () => {
    const api = fakeDesktop(['overlay', 'mini']);
    const { meeting } = fakeMeeting();
    const handlers = actions();
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, handlers));
    const connected = meeting.media.state.get();
    meeting.media.state.set({ ...connected, status: 'recovering' });
    api.emit('mini.action', { id: 'mic', want: false, seq: 1 });
    await act(async () => {});
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 1, result: 'ignored', reason: 'link' });
    expect(meeting.media.setMicrophone).not.toHaveBeenCalled();
    meeting.media.state.set({ ...connected, screen: true });
    api.emit('mini.action', { id: 'screen', want: true, seq: 2 });
    await act(async () => {});
    expect(meeting.media.stopScreen).not.toHaveBeenCalled();
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 2, result: 'ok' });
    api.emit('mini.action', { id: 'screen', want: false, seq: 3 });
    await act(async () => {});
    expect(meeting.media.stopScreen).toHaveBeenCalled();
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 3, result: 'ok' });
    api.emit('mini.action', { id: 'leave', seq: 4 });
    await act(async () => {});
    expect(handlers.leave).toHaveBeenCalled();
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 4, result: 'ok' });
    api.emit('mini.action', { id: 'record', seq: 5 });
    await act(async () => {});
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 5, result: 'ignored', reason: 'unknown' });
  });

  it('R137: оболочка до 1.0.11 — нажатие без want и seq переключает, как раньше, и ответа не ждёт', async () => {
    const api = fakeDesktop(['overlay', 'mini']);
    const { meeting } = fakeMeeting();
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    api.emit('mini.action', { id: 'mic' });
    await act(async () => {});
    expect(meeting.media.toggle).toHaveBeenCalledWith('microphone');
    expect(meeting.media.setMicrophone).not.toHaveBeenCalled();
    expect(sent(api, 'mini.ack')).toEqual([]);
  });

  it('«Звук встречи» (R156): в состоянии мини-окна и трея — сразу, как сменился', () => {
    const api = fakeDesktop(['overlay', 'mini']);
    const { meeting } = fakeMeeting();
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    expect(sent(api, 'mini.state').at(-1)).toMatchObject({ deafened: false, seq: 1 });
    act(() => meeting.media.deafened.set(true));
    expect(sent(api, 'mini.state').at(-1)).toMatchObject({ deafened: true, seq: 2 });
  });

  it('«Звук встречи» (R156): нажатие с нужным состоянием — ставится, уже так — ничего; ответ mini.ack; связи не ждёт', async () => {
    const api = fakeDesktop(['overlay', 'mini']);
    const { meeting } = fakeMeeting();
    meeting.media.setDeafened.mockImplementation(async (value: boolean) => {
      meeting.media.deafened.set(value);
    });
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    api.emit('mini.action', { id: 'deafen', want: true, seq: 11 });
    await act(async () => {});
    expect(meeting.media.setDeafened).toHaveBeenCalledWith(true);
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 11, result: 'ok' });
    // Мини-окно не успело увидеть новое состояние и просит то же — уже так.
    api.emit('mini.action', { id: 'deafen', want: true, seq: 12 });
    await act(async () => {});
    expect(meeting.media.setDeafened).toHaveBeenCalledTimes(1);
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 12, result: 'ok' });
    // Связь восстанавливается — звук встречи всё равно включается: его возвращает сама страница.
    meeting.media.state.set({ ...meeting.media.state.get(), status: 'recovering' });
    api.emit('mini.action', { id: 'deafen', want: false, seq: 13 });
    await act(async () => {});
    expect(meeting.media.setDeafened).toHaveBeenLastCalledWith(false);
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 13, result: 'ok' });
    // Без want (как «переключить») — наоборот от нынешнего.
    api.emit('mini.action', { id: 'deafen', seq: 14 });
    await act(async () => {});
    expect(meeting.media.setDeafened).toHaveBeenLastCalledWith(true);
  });

  it('«Звук встречи» (R156): не встал — ignored failed, мини-окно перестаёт ждать', async () => {
    const api = fakeDesktop(['overlay', 'mini']);
    const { meeting } = fakeMeeting();
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    api.emit('mini.action', { id: 'deafen', want: true, seq: 5 });
    await act(async () => {});
    expect(sent(api, 'mini.ack').at(-1)).toEqual({ seq: 5, result: 'ignored', reason: 'failed' });
  });

  it('«Показать игру» (R104): окно игры — «Плавность», 60 fps и звук игры, без окна выбора', async () => {
    const api = fakeDesktop(['overlay', 'overlay.widget', 'golive', 'capture', 'capture.app-audio']);
    const { meeting } = fakeMeeting();
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    api.emit('golive', { id: 'window:1234:0', name: 'Counter-Strike 2' });
    await act(async () => {});
    expect(api.invoke).toHaveBeenCalledWith('capture.select', { id: 'window:1234:0', audio: 'app' });
    expect(meeting.media.share).toHaveBeenCalledWith(
      { resolution: 1080, fps: 60, mode: 'smooth', audio: 'system' },
      expect.anything(),
    );
    api.emit('golive', { id: 'screen:1:0' });
    await act(async () => {});
    expect(meeting.media.share).toHaveBeenCalledTimes(1);
  });

  it('оболочка до R63 — прежнее overlay.state: имена и ступени, без аватаров', () => {
    vi.useFakeTimers();
    const api = fakeDesktop(['overlay']);
    const { meeting } = fakeMeeting();
    renderHook(() => useDesktopOverlay(meeting as unknown as Meeting, false, actions()));
    act(() => void vi.advanceTimersByTime(150));
    expect(sent(api, 'overlay.state').at(-1)).toMatchObject({
      participants: expect.arrayContaining([{ name: 'Миша', tier: 3, speaking: false }]),
    });
    expect(sent(api, 'overlay.roster')).toEqual([]);
    vi.useRealTimers();
  });
});
