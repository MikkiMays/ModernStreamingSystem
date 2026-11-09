import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setManualNode } from '../core/node-choice';
import { savePreferences } from '../core/preferences';
import { nodeProbe } from '../media/node-probe';
import { Ping } from './Ping';

/*
 * PING на главной — время ответа узла, через который пойдёт новая встреча (владелец 09.11: «я в Москве,
 * нода московская, а пинг 50» — мерился сервер с ядром во Франкфурте).
 */
const nodes = [
  {
    id: 'main',
    title: { ru: 'Франкфурт' },
    rtcUrl: 'wss://cord.test',
    probeUrl: 'https://cord.test',
    control: true,
  },
  {
    id: 'msk',
    title: { ru: 'Москва' },
    rtcUrl: 'wss://rtc-msk.test',
    probeUrl: 'https://msk.test',
    control: false,
  },
];

let answer: (url: string) => Promise<Response>;
const asked: string[] = [];

beforeEach(() => {
  localStorage.clear();
  savePreferences({ showPing: true });
  asked.length = 0;
  answer = async () => new Response('{}', { status: 200 });
  vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    // Рядом с пингом главная спрашивает и загрузку сервера (`/api/v1/load`) — здесь важен только замер.
    if (url.endsWith('/api/v1/ping')) asked.push(url);
    return answer(url);
  });
  vi.spyOn(nodeProbe, 'refresh').mockResolvedValue({ at: 1, node: 'msk', measures: [] });
  vi.spyOn(nodeProbe, 'last').mockReturnValue({ at: 1, node: 'msk', measures: [] });
  nodeProbe.schedule(nodes);
});
afterEach(() => {
  cleanup();
  setManualNode(null);
  savePreferences({ showPing: false });
  nodeProbe.schedule([]);
  vi.restoreAllMocks();
});

it('меряет узел, выбранный для новой встречи, а не сервер с ядром', async () => {
  render(<Ping />);
  const badge = await screen.findByRole('status');
  await waitFor(() =>
    expect(badge).toHaveAttribute('title', 'Время ответа узла Москва — через него пойдёт новая встреча'),
  );
  expect(asked[0]).toBe('https://msk.test/api/v1/ping');
  expect(badge).toHaveTextContent(/^PING · \d+ мс/);
});

it('узел, выбранный руками, важнее выбора замера', async () => {
  setManualNode('main');
  render(<Ping />);
  await waitFor(() => expect(asked[0]).toBe('https://cord.test/api/v1/ping'));
  expect(await screen.findByRole('status')).toHaveAttribute(
    'title',
    'Время ответа узла Франкфурт — через него пойдёт новая встреча',
  );
});

it('узел не ответил — меряется сам сервер, «Нет связи» только если молчит и он', async () => {
  answer = async (url) =>
    url.startsWith('https://msk.test') ? new Response('', { status: 502 }) : new Response('{}');
  render(<Ping />);
  const badge = await screen.findByRole('status');
  await waitFor(() => expect(asked).toContain('/api/v1/ping'));
  await waitFor(() => expect(badge).toHaveAttribute('title', 'Время ответа сервера'));
  expect(badge).toHaveTextContent(/^PING · \d+ мс/);
  answer = async () => new Response('', { status: 503 });
  cleanup();
  render(<Ping />);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('PING · Нет связи'));
});

it('один узел — меряется сервер, как раньше', async () => {
  nodeProbe.schedule([nodes[0]!]);
  render(<Ping />);
  await waitFor(() => expect(asked[0]).toBe('/api/v1/ping'));
});
