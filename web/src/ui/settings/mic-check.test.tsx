import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../../core/meeting';
import { readPreferences } from '../../core/preferences';
import { Store } from '../../core/store';
import { AudioSection } from './AudioSection';

/*
  «Микрофон» (R141): шкала уровня живёт сама, пока раздел открыт, — без кнопки «Проверить». Проба —
  пять секунд записи, тут же она звучит и пропадает: проигрывателя, который нечем убрать, под строкой
  больше нет. Во встрече с включённым микрофоном шкала берёт уровень комнаты и второго захвата нет.
*/

const capture = vi.hoisted(() => ({
  track: {
    mediaStreamTrack: { kind: 'audio' },
    stop: vi.fn(),
    setAudioContext: vi.fn(),
    setProcessor: vi.fn(async () => {}),
  },
  denied: false,
}));
vi.mock('livekit-client', async (original) => ({
  ...(await original<typeof import('livekit-client')>()),
  createLocalAudioTrack: vi.fn(async () => {
    if (capture.denied) throw new DOMException('denied', 'NotAllowedError');
    return capture.track;
  }),
}));
vi.mock('../../media/audio', async (original) => ({
  ...(await original<typeof import('../../media/audio')>()),
  needsAudioProcessor: () => false,
}));
vi.mock('../useMicLevel', () => ({ useMicLevel: () => 37 }));

class FakeContext {
  state = 'running';
  resume = async () => {};
  close = async () => {
    this.state = 'closed';
  };
  createMediaStreamSource = () => ({ connect: () => {} });
  // Громкий ровный сигнал: шкала обязана показать не ноль.
  createAnalyser = () => ({ fftSize: 512, getFloatTimeDomainData: (data: Float32Array) => data.fill(0.5) });
}
class FakeRecorder {
  static last: FakeRecorder | null = null;
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() {
    FakeRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['x']) });
    this.onstop?.();
  }
}
class FakeAudio {
  static last: FakeAudio | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(async () => {});
  pause = vi.fn();
  removeAttribute = vi.fn();
  constructor(public src: string) {
    FakeAudio.last = this;
  }
}

const revoked: string[] = [];
beforeEach(() => {
  localStorage.clear();
  capture.denied = false;
  capture.track.stop.mockClear();
  revoked.length = 0;
  FakeAudio.last = null;
  FakeRecorder.last = null;
  vi.useFakeTimers();
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('MediaStream', class {});
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:probe',
    revokeObjectURL: (url: string) => revoked.push(url),
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices: async () => [], addEventListener: () => {}, removeEventListener: () => {} },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

const meter = () => screen.getByRole('meter', { name: 'Уровень микрофона' });
const settle = () => act(async () => {});

function section(meeting?: Meeting) {
  return render(<AudioSection preferences={readPreferences()} change={async () => {}} meeting={meeting} />);
}

describe('«Микрофон»: уровень сам и проба без проигрывателя (R141)', () => {
  it('шкала оживает при открытии раздела — без кнопки «Проверить»; закрыли раздел — микрофон отпущен', async () => {
    const { unmount } = section();
    await settle();
    await act(async () => vi.advanceTimersByTime(150));
    expect(Number(meter().getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Остановить проверку микрофона' })).toBeNull();
    unmount();
    expect(capture.track.stop).toHaveBeenCalled();
  });

  it('«Проверить» — пять секунд записи с отсчётом, затем запись звучит и пропадает', async () => {
    section();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Записать 5 секунд и послушать' }));
    await settle();
    expect(screen.getByRole('status')).toHaveTextContent('Говорите… 5');
    await act(async () => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('status')).toHaveTextContent('Говорите… 3');
    await act(async () => vi.advanceTimersByTime(3000));
    await settle();
    expect(screen.getByRole('status')).toHaveTextContent('Слушаем запись…');
    expect(FakeAudio.last?.src).toBe('blob:probe');
    expect(FakeAudio.last?.play).toHaveBeenCalled();
    // Проигрывателя на странице нет — слушают один раз, и запись забывается.
    expect(document.querySelector('audio')).toBeNull();
    act(() => FakeAudio.last?.onended?.());
    expect(revoked).toEqual(['blob:probe']);
    expect(screen.getByRole('button', { name: 'Записать 5 секунд и послушать' })).toHaveTextContent(
      'Проверить',
    );
    // Микрофон шкалы остался слушать: проба его не забрала.
    expect(capture.track.stop).not.toHaveBeenCalled();
  });

  it('нажатие во время записи обрывает пробу без прослушивания', async () => {
    section();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Записать 5 секунд и послушать' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Остановить проверку микрофона' }));
    await act(async () => vi.advanceTimersByTime(6000));
    expect(FakeAudio.last).toBeNull();
    expect(screen.getByRole('button', { name: 'Записать 5 секунд и послушать' })).toBeInTheDocument();
  });

  it('нет доступа — понятная причина, сам не повторяет; «Проверить» спрашивает снова', async () => {
    capture.denied = true;
    section();
    await settle();
    expect(screen.getByRole('alert')).toHaveTextContent('Нет доступа к микрофону — разрешите его для Cord');
    await act(async () => vi.advanceTimersByTime(1000));
    capture.denied = false;
    fireEvent.click(screen.getByRole('button', { name: 'Записать 5 секунд и послушать' }));
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Говорите… 5');
  });

  it('во встрече с включённым микрофоном — уровень комнаты и без своего захвата', async () => {
    const state = new Store({ microphone: true });
    section({ media: { state }, admission: { participantId: 'me' } } as unknown as Meeting);
    await settle();
    expect(meter()).toHaveAttribute('aria-valuenow', '37');
    expect(meter()).toHaveAttribute('title', 'Так вас слышат во встрече сейчас');
    const { createLocalAudioTrack } = await import('livekit-client');
    expect(createLocalAudioTrack).not.toHaveBeenCalled();
    // Выключили микрофон во встрече — шкала слушает сама.
    act(() => state.set({ microphone: false }));
    await settle();
    expect(createLocalAudioTrack).toHaveBeenCalled();
  });
});
