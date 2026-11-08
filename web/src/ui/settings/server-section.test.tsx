import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../../core/meeting';
import { MANUAL_NODE_KEY, setManualNode } from '../../core/node-choice';
import { Store } from '../../core/store';
import { nodeProbe } from '../../media/node-probe';
import { ServerSection } from './ServerSection';

/*
  «Настройки → Сервер» (R200, слова владельца): текста про автоматический выбор нет; по умолчанию
  «Авто», ниже — список узлов с флагом, городом, замером и загрузкой. Вне встречи выбор — для следующей
  встречи; во встрече — перевод этой встречи (только создатель), честно про пару секунд разрыва.
*/

const NODES = [
  {
    id: 'fra',
    title: { ru: 'Франкфурт', en: 'Frankfurt' },
    rtcUrl: 'wss://fra',
    probeUrl: 'https://fra',
    control: true,
    country: 'DE',
  },
  {
    id: 'hel',
    title: { ru: 'Хельсинки', en: 'Helsinki' },
    rtcUrl: 'wss://hel',
    probeUrl: 'https://hel',
    control: false,
    country: 'FI',
  },
  {
    id: 'msk',
    title: { ru: 'Москва', en: 'Moscow' },
    rtcUrl: 'wss://msk',
    probeUrl: 'https://msk',
    control: false,
    country: 'RU',
  },
];
const PROBE = {
  at: 1,
  node: 'hel',
  measures: [
    { node: 'fra', tcpMs: 45, udpMs: 41, udpOpen: true },
    { node: 'hel', tcpMs: 14, udpMs: 12, udpOpen: true },
    { node: 'msk', tcpMs: null, udpMs: null, udpOpen: false },
  ],
};
const LOADS = [
  { id: 'fra', title: NODES[0]!.title, country: 'DE', control: true, level: 1, state: 'ok' },
  { id: 'hel', title: NODES[1]!.title, country: 'FI', control: false, level: 3, state: 'busy' },
  { id: 'msk', title: NODES[2]!.title, country: 'RU', control: false, level: 4, state: 'down' },
];

function fakeMeeting(can: string[], mediaNode = 'fra') {
  return {
    admission: { roomId: 'r', participantId: 'self' },
    snapshot: new Store({ mediaNode, mediaMoves: 0, participants: [{ id: 'self' }], you: { can } }),
    ended: new Store<string | null>(null),
    api: { moveMedia: vi.fn(async () => ({ ok: true })) },
  } as unknown as Meeting & { api: { moveMedia: ReturnType<typeof vi.fn> } };
}

beforeEach(() => {
  localStorage.clear();
  setManualNode(null);
  vi.spyOn(nodeProbe, 'last').mockReturnValue(PROBE);
  vi.spyOn(nodeProbe, 'refresh').mockResolvedValue(PROBE);
  nodeProbe.schedule(NODES);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.endsWith('/api/v1/nodes') ? LOADS : { level: 1, state: 'ok', updatedAt: 1 };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  nodeProbe.schedule([]);
});

const show = (meeting: Meeting | null = null) =>
  render(<ServerSection showPing={false} changePing={vi.fn()} meeting={meeting} />);

const group = () => screen.getByRole('radiogroup', { name: 'Узел встречи' });

describe('«Сервер»: Авто и список узлов', () => {
  it('вне встречи: «Авто» по умолчанию, узлы с флагом, городом, замером и загрузкой; текста про автовыбор нет', async () => {
    show();
    expect(screen.queryByText(/менять сервер не нужно/)).not.toBeInTheDocument();
    const auto = within(group()).getByRole('radio', { name: /Авто/ });
    expect(auto).toBeChecked();
    // Порядок — по замеру: Хельсинки 12 мс впереди Франкфурта 41 мс; Москва не отвечает — серая.
    const radios = within(group()).getAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(['auto', 'hel', 'fra', 'msk']);
    expect(screen.getByText('Хельсинки')).toBeInTheDocument();
    expect(screen.getByText('12 мс')).toBeInTheDocument();
    expect(screen.getByText('41 мс')).toBeInTheDocument();
    expect(document.querySelector('.ui-flag[data-country="FI"]')).not.toBeNull();
    await screen.findByRole('img', { name: 'Загрузка сервера: высокая' });
    expect(screen.getByText('не отвечает')).toBeInTheDocument();
    expect(within(group()).getByRole('radio', { name: /Москва/ })).toBeDisabled();
  });

  it('вне встречи выбор узла помнится для следующей встречи, «Авто» сбрасывает', () => {
    show();
    fireEvent.click(within(group()).getByRole('radio', { name: /Хельсинки/ }));
    expect(localStorage.getItem(MANUAL_NODE_KEY)).toBe('hel');
    expect(within(group()).getByRole('radio', { name: /Хельсинки/ })).toBeChecked();
    expect(screen.getByText(/Следующая встреча, которую вы создадите/)).toBeInTheDocument();
    fireEvent.click(within(group()).getByRole('radio', { name: /Авто/ }));
    expect(localStorage.getItem(MANUAL_NODE_KEY)).toBeNull();
    expect(screen.queryByText(/Следующая встреча/)).not.toBeInTheDocument();
  });

  it('во встрече создатель переводит её: подтверждение честно говорит про пару секунд, радио встаёт по снимку', async () => {
    const meeting = fakeMeeting(['media.move'], 'fra');
    show(meeting);
    // «Авто» во встрече не предлагается — узел задан; текущий узел первым и отмечен.
    expect(within(group()).queryByRole('radio', { name: /Авто/ })).not.toBeInTheDocument();
    const radios = within(group()).getAllByRole('radio');
    expect((radios[0] as HTMLInputElement).value).toBe('fra');
    expect(radios[0]).toBeChecked();
    expect(screen.getByText('Узел этой встречи')).toBeInTheDocument();
    fireEvent.click(within(group()).getByRole('radio', { name: /Хельсинки/ }));
    const confirm = screen.getByRole('group', { name: 'Перевести встречу в Хельсинки?' });
    expect(confirm).toHaveTextContent(/пару секунд/);
    // Пока не подтвердили — встреча там же.
    expect(radios[0]).toBeChecked();
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Перевести' }));
    });
    expect(meeting.api.moveMedia).toHaveBeenCalledWith('hel', expect.any(String));
    expect(screen.getByRole('status')).toHaveTextContent('Переводим встречу в Хельсинки…');
    act(() => {
      meeting.snapshot.update((s) => ({ ...s, mediaNode: 'hel', mediaMoves: 1 }));
    });
    expect(within(group()).getByRole('radio', { name: /Хельсинки/ })).toBeChecked();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // Ничего в память устройства: перевод встречи — не выбор узла для следующей.
    expect(localStorage.getItem(MANUAL_NODE_KEY)).toBeNull();
  });

  it('во встрече гость видит узлы, но перевести не может', () => {
    show(fakeMeeting([], 'fra'));
    expect(within(group()).getByRole('radio', { name: /Хельсинки/ })).toBeDisabled();
    expect(screen.getByText(/может только её создатель/)).toBeInTheDocument();
  });

  it('отказ ядра — словами под списком, выбор остаётся прежним', async () => {
    const meeting = fakeMeeting(['media.move'], 'fra');
    meeting.api.moveMedia.mockRejectedValue(new Error('boom'));
    show(meeting);
    fireEvent.click(within(group()).getByRole('radio', { name: /Хельсинки/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Перевести' }));
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(within(group()).getByRole('radio', { name: /Франкфурт/ })).toBeChecked();
  });

  it('один узел — выбирать не из чего: строка с узлом, как в 1.2.1', () => {
    nodeProbe.schedule([NODES[0]!]);
    show();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.getByText('Франкфурт · 41 мс')).toBeInTheDocument();
  });
});
