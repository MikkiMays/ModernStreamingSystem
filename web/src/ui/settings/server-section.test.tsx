import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../../core/meeting';
import { MANUAL_NODE_KEY, setManualNode } from '../../core/node-choice';
import { Store } from '../../core/store';
import { nodeProbe } from '../../media/node-probe';
import { ServerSection } from './ServerSection';

/*
  «Настройки → Сервер» (R200, R220, слова владельца): по умолчанию «Авто»; список узлов сразу не показывается —
  в строке кнопка с текущим выбором, по нажатию — список с «Авто (рекомендуется)» и узлами: флаг, город, замер,
  загрузка, текущий отмечен. Вне встречи выбор — для следующей встречи; во встрече — перевод этой встречи (только
  создатель), честно про пару секунд разрыва.
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

/** Кнопка выбора узла: её имя — подпись строки и текущий выбор. */
const trigger = () => screen.getByRole('button', { name: /Узел встречи/ });
const list = () => screen.getByRole('listbox', { name: 'Узел встречи' });
const open = async () => {
  fireEvent.click(trigger());
  return await screen.findByRole('listbox', { name: 'Узел встречи' });
};
const option = (name: RegExp) => within(list()).getByRole('option', { name });

describe('«Сервер»: кнопка «Авто» и список узлов по нажатию', () => {
  it('вне встречи: в строке только «Авто», список — по нажатию: «Авто (рекомендуется)» и узлы с флагом, городом, замером и загрузкой', async () => {
    show();
    expect(screen.queryByText(/менять сервер не нужно/)).not.toBeInTheDocument();
    // Сразу — ни списка, ни городов: только кнопка с текущим выбором.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Хельсинки')).not.toBeInTheDocument();
    expect(trigger()).toHaveAccessibleName('Узел встречи Авто');
    const box = await open();
    const options = within(box).getAllByRole('option');
    // Порядок — «Авто», затем по замеру: Хельсинки 12 мс впереди Франкфурта 41 мс; Москва не отвечает — серая.
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('Авто (рекомендуется)'),
      expect.stringContaining('Хельсинки'),
      expect.stringContaining('Франкфурт'),
      expect.stringContaining('Москва'),
    ]);
    expect(option(/^Авто/)).toHaveAttribute('aria-selected', 'true');
    expect(option(/^Авто/)).toHaveTextContent('Сейчас ближе всех: Хельсинки · 12 мс');
    expect(option(/^Хельсинки/)).toHaveTextContent('12 мс');
    expect(option(/^Франкфурт/)).toHaveTextContent('41 мс');
    expect(document.querySelector('.ui-flag[data-country="FI"]')).not.toBeNull();
    await within(box).findByRole('img', { name: 'Загрузка сервера: высокая' });
    expect(option(/^Москва/)).toHaveTextContent('не отвечает');
    expect(option(/^Москва/)).toHaveAttribute('aria-disabled', 'true');
  });

  it('вне встречи выбор узла помнится для следующей встречи и виден на кнопке с флагом, «Авто» сбрасывает', async () => {
    show();
    await open();
    fireEvent.click(option(/^Хельсинки/));
    expect(localStorage.getItem(MANUAL_NODE_KEY)).toBe('hel');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(trigger()).toHaveAccessibleName('Узел встречи Хельсинки');
    expect(trigger().querySelector('.ui-flag[data-country="FI"]')).not.toBeNull();
    expect(screen.getByText(/Следующая встреча, которую вы создадите/)).toBeInTheDocument();
    await open();
    expect(option(/^Хельсинки/)).toHaveAttribute('aria-selected', 'true');
    // Недоступный узел не выбирается.
    fireEvent.click(option(/^Москва/));
    expect(localStorage.getItem(MANUAL_NODE_KEY)).toBe('hel');
    fireEvent.click(option(/^Авто/));
    expect(localStorage.getItem(MANUAL_NODE_KEY)).toBeNull();
    expect(trigger()).toHaveAccessibleName('Узел встречи Авто');
    expect(screen.queryByText(/Следующая встреча/)).not.toBeInTheDocument();
  });

  it('клавиатура: фокус на выбранном, стрелки и End ходят мимо недоступного', async () => {
    show();
    await open();
    await waitFor(() => expect(option(/^Авто/)).toHaveFocus());
    fireEvent.keyDown(list(), { key: 'ArrowDown' });
    await waitFor(() => expect(option(/^Хельсинки/)).toHaveFocus());
    fireEvent.keyDown(list(), { key: 'End' });
    // Москва не отвечает — последним доступным остаётся Франкфурт.
    await waitFor(() => expect(option(/^Франкфурт/)).toHaveFocus());
    fireEvent.click(option(/^Франкфурт/));
    expect(localStorage.getItem(MANUAL_NODE_KEY)).toBe('fra');
  });

  it('во встрече создатель переводит её: подтверждение честно говорит про пару секунд, кнопка встаёт по снимку', async () => {
    const meeting = fakeMeeting(['media.move'], 'fra');
    show(meeting);
    expect(trigger()).toHaveAccessibleName('Узел встречи Франкфурт');
    await open();
    // «Авто» во встрече не предлагается — узел задан; текущий узел первым и отмечен.
    expect(within(list()).queryByRole('option', { name: /Авто/ })).not.toBeInTheDocument();
    const options = within(list()).getAllByRole('option');
    expect(options[0]).toHaveTextContent('Франкфурт');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveTextContent('Узел этой встречи');
    fireEvent.click(option(/^Хельсинки/));
    const confirm = screen.getByRole('group', { name: 'Перевести встречу в Хельсинки?' });
    expect(confirm).toHaveTextContent(/пару секунд/);
    // Пока не подтвердили — встреча там же.
    expect(trigger()).toHaveAccessibleName('Узел встречи Франкфурт');
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Перевести' }));
    });
    expect(meeting.api.moveMedia).toHaveBeenCalledWith('hel', expect.any(String));
    expect(screen.getByRole('status')).toHaveTextContent('Переводим встречу в Хельсинки…');
    act(() => {
      meeting.snapshot.update((s) => ({ ...s, mediaNode: 'hel', mediaMoves: 1 }));
    });
    expect(trigger()).toHaveAccessibleName('Узел встречи Хельсинки');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // Ничего в память устройства: перевод встречи — не выбор узла для следующей.
    expect(localStorage.getItem(MANUAL_NODE_KEY)).toBeNull();
  });

  it('во встрече гость видит узлы, но перевести не может', async () => {
    show(fakeMeeting([], 'fra'));
    expect(screen.getByText(/может только её создатель/)).toBeInTheDocument();
    await open();
    expect(option(/^Хельсинки/)).toHaveAttribute('aria-disabled', 'true');
  });

  it('отказ ядра — словами под строкой, выбор остаётся прежним', async () => {
    const meeting = fakeMeeting(['media.move'], 'fra');
    meeting.api.moveMedia.mockRejectedValue(new Error('boom'));
    show(meeting);
    await open();
    fireEvent.click(option(/^Хельсинки/));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Перевести' }));
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(trigger()).toHaveAccessibleName('Узел встречи Франкфурт');
  });

  it('один узел — выбирать не из чего: строка с узлом, как в 1.2.1, без кнопки', () => {
    nodeProbe.schedule([NODES[0]!]);
    show();
    expect(screen.queryByRole('button', { name: /Узел встречи/ })).not.toBeInTheDocument();
    expect(screen.getByText('Франкфурт · 41 мс')).toBeInTheDocument();
  });

  it('один узел без замера — только имя, без «не отвечает»: один узел не мерят, он живой', () => {
    vi.spyOn(nodeProbe, 'last').mockReturnValue(null);
    nodeProbe.schedule([NODES[0]!]);
    show();
    expect(screen.getByText('Франкфурт')).toBeInTheDocument();
    expect(screen.queryByText(/не отвечает/)).not.toBeInTheDocument();
  });

  it('неявный узел без реестра (стенд, продукт до подключения узлов) — строки узла нет', () => {
    vi.spyOn(nodeProbe, 'last').mockReturnValue(null);
    nodeProbe.schedule([{ id: 'main', title: {}, rtcUrl: 'wss://x', probeUrl: 'https://x', control: true }]);
    show();
    expect(screen.queryByText(/main/)).not.toBeInTheDocument();
    expect(screen.queryByText(/не отвечает/)).not.toBeInTheDocument();
  });
});
