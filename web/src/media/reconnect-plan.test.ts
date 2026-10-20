import { describe, expect, it } from 'vitest';
import { NUDGE_INTERVAL_MS, reconnectAction, type ReconnectSignals } from './reconnect-plan';

const signals = (patch: Partial<ReconnectSignals> = {}): ReconnectSignals => ({
  trigger: 'online',
  sdk: 'connected',
  recovering: false,
  connecting: false,
  sinceNudgeMs: Infinity,
  ...patch,
});

describe('что делать по знаку сети', () => {
  it('SDK «подключён», а сеть сменилась — resume сразу, не дожидаясь таймаута пинга', () => {
    expect(reconnectAction(signals())).toBe('resume');
    expect(reconnectAction(signals({ trigger: 'ice-disconnected' }))).toBe('resume');
  });

  it('два толчка подряд — один: второй раньше интервала не идёт', () => {
    expect(reconnectAction(signals({ sinceNudgeMs: NUDGE_INTERVAL_MS - 1 }))).toBe('none');
    expect(reconnectAction(signals({ sinceNudgeMs: NUDGE_INTERVAL_MS }))).toBe('resume');
  });

  it('SDK сдался — полный connect, если идёт окно восстановления и мы ещё не подключаемся', () => {
    expect(reconnectAction(signals({ sdk: 'disconnected', recovering: true }))).toBe('connect');
    expect(reconnectAction(signals({ sdk: 'disconnected', recovering: true, connecting: true }))).toBe(
      'none',
    );
    expect(reconnectAction(signals({ sdk: 'disconnected', recovering: false }))).toBe('none');
  });

  it('SDK уже переподключается или подключается — не мешать', () => {
    expect(reconnectAction(signals({ sdk: 'reconnecting' }))).toBe('none');
    expect(reconnectAction(signals({ sdk: 'connecting' }))).toBe('none');
    expect(reconnectAction(signals({ sdk: 'signalReconnecting' }))).toBe('none');
  });

  it('возвращение к экрану — повод подключиться, если SDK сдался, но не повод перезапускать ICE', () => {
    expect(reconnectAction(signals({ trigger: 'visible' }))).toBe('none');
    expect(reconnectAction(signals({ trigger: 'visible', sdk: 'disconnected', recovering: true }))).toBe(
      'connect',
    );
  });
});

describe('возвращение из заморозки (E12)', () => {
  it('страница стояла — сокет SDK, скорее всего, мёртв: resume сразу, как по знаку сети', () => {
    expect(reconnectAction(signals({ trigger: 'woke' }))).toBe('resume');
    expect(reconnectAction(signals({ trigger: 'woke', sinceNudgeMs: NUDGE_INTERVAL_MS - 1 }))).toBe('none');
  });

  it('SDK сдался — полный connect; переподключается сам — не мешать', () => {
    expect(reconnectAction(signals({ trigger: 'woke', sdk: 'disconnected', recovering: true }))).toBe(
      'connect',
    );
    expect(reconnectAction(signals({ trigger: 'woke', sdk: 'reconnecting' }))).toBe('none');
  });
});
