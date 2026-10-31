import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../core/meeting';
import { Store } from '../core/store';
import { CallDock, type CallDockProps } from './CallDock';

/*
  Пульт: показ экрана останавливают красной кнопкой с крестиком (R77), у чата — красный кружок с
  числом непрочитанных (R87). На телефоне чат живёт в «ещё» — кружок на «ещё» и число у пункта.
*/

function fakeMeeting({ screen = false, unread = 0 } = {}) {
  return {
    admission: { roomId: 'room', participantId: 'me', credential: 'token' },
    unread: new Store(unread),
    media: {
      state: new Store({ status: 'connected', microphone: false, camera: false, screen }),
      deafened: new Store(false),
      outbound: new Store(null),
      preferences: new Store({ screen: {}, layout: 'grid', devices: {} }),
      pip: { state: new Store({ available: false, active: false }), toggle: vi.fn() },
      share: vi.fn(),
      toggle: vi.fn(),
      setDeafened: vi.fn(),
      saveSettings: vi.fn(),
    },
  } as unknown as Meeting & { unread: Store<number>; media: { share: ReturnType<typeof vi.fn> } };
}

function dock(meeting: Meeting, extra: Partial<CallDockProps> = {}) {
  return render(
    <CallDock
      meeting={meeting}
      compact={false}
      ended={false}
      panel={null}
      togglePanel={vi.fn()}
      people={2}
      fullscreen={false}
      toggleFullscreen={vi.fn()}
      onLeave={vi.fn()}
      onSettings={vi.fn()}
      onDiagnostics={vi.fn()}
      {...extra}
    />,
  );
}

afterEach(cleanup);

describe('показ экрана (R77)', () => {
  it('не идёт — обычная кнопка «Показать экран»', () => {
    dock(fakeMeeting());
    const share = screen.getByRole('button', { name: 'Показать экран' });
    expect(share).not.toHaveClass('ui-icon-button--danger');
  });

  it('идёт — красная кнопка с крестиком «Остановить показ», без «нажатого» вида', () => {
    const meeting = fakeMeeting({ screen: true });
    dock(meeting);
    const stop = screen.getByRole('button', { name: 'Остановить показ' });
    expect(stop).toHaveClass('ui-icon-button--danger');
    expect(stop).not.toHaveAttribute('aria-pressed');
    expect(stop.querySelector('svg.lucide-monitor-x')).not.toBeNull();
    fireEvent.click(stop);
    expect(meeting.media.share).toHaveBeenCalledTimes(1);
  });
});

describe('непрочитанные в чате (R87)', () => {
  it('нет непрочитанных — кружка нет', () => {
    dock(fakeMeeting());
    expect(screen.getByRole('button', { name: 'Чат' }).querySelector('.dock-badge')).toBeNull();
  });

  it('красный кружок с числом, для диктора — «Чат, 3 непрочитанных»; больше девяти — «9+»', () => {
    const meeting = fakeMeeting({ unread: 3 });
    dock(meeting);
    const chat = screen.getByRole('button', { name: 'Чат, 3 непрочитанных' });
    expect(chat.querySelector('.dock-badge')).toHaveTextContent('3');
    act(() => meeting.unread.set(12));
    expect(
      screen.getByRole('button', { name: 'Чат, 12 непрочитанных' }).querySelector('.dock-badge'),
    ).toHaveTextContent('9+');
    act(() => meeting.unread.set(1));
    expect(screen.getByRole('button', { name: 'Чат, 1 непрочитанное' })).toBeInTheDocument();
  });

  it('телефон: кружок на «ещё», число — у пункта «Чат и файлы»', async () => {
    dock(fakeMeeting({ unread: 2 }), { compact: true });
    const more = screen.getByRole('button', { name: 'Настройки и действия' });
    expect(more.querySelector('.dock-badge')).toHaveTextContent('2');
    fireEvent.click(more);
    const item = await screen.findByRole('menuitem', { name: /Чат и файлы/ });
    expect(within(item).getByText('2')).toBeInTheDocument();
  });
});

describe('«звук встречи» — отдельная кнопка слева от микрофона (R156)', () => {
  const width = (px: number) =>
    vi.stubGlobal('matchMedia', (query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      return {
        matches: max ? px <= Number(max[1]) : false,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    });
  afterEach(() => vi.unstubAllGlobals());

  it('своя плашка первой, слева от группы микрофона; из «ещё» пункт убран', () => {
    width(1440);
    const meeting = fakeMeeting();
    dock(meeting);
    const groups = screen.getAllByRole('group');
    expect(groups[0]).toHaveAccessibleName('Звук встречи');
    const button = within(groups[0]!).getByRole('button', { name: 'Выключить звук встречи' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(within(groups[1]!).getByRole('button', { name: 'Включить микрофон' })).toBeInTheDocument();
    fireEvent.click(button);
    expect(meeting.media.setDeafened).toHaveBeenCalledWith(true);
  });

  it('выключен — красные наушники «Включить звук встречи»', () => {
    width(1440);
    const meeting = fakeMeeting();
    act(() => meeting.media.deafened.set(true));
    dock(meeting);
    const button = screen.getByRole('button', { name: 'Включить звук встречи' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button.querySelector('svg.lucide-headphone-off')).not.toBeNull();
  });

  it('уже 375 px — первой кнопкой в группе микрофона, отдельной плашки нет', () => {
    width(360);
    dock(fakeMeeting());
    expect(screen.queryByRole('group', { name: 'Звук встречи' })).toBeNull();
    const media = screen.getByRole('group', { name: 'Микрофон и камера' });
    expect(within(media).getAllByRole('button')[0]).toHaveAccessibleName('Выключить звук встречи');
  });
});
