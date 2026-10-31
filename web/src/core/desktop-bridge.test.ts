import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyLanguage, i18next, t } from '../i18n';
import { detectLanguage } from '../i18n/languages';
import { readPreferences } from './preferences';
import { decideNotification, type NotifyContext } from './desktop-notify';
import { desktopPageState } from './desktop-state';
import { hotkeyStatusText, type HotkeyStatus } from './desktop';
import type { Meeting } from './meeting';
import { parseShellGpu } from '../media/codec-probe';

/*
  Мост v2 клиента Windows — копия контракта в ядре (`contracts/desktop-bridge.v2.schema.json`).
  Сообщения, которые шлёт и принимает веб, сверяются со схемой: оболочка молча отбрасывает всё, что
  не прошло её проверку (`messages.ts`), и расхождение было бы видно только по пропавшим toast'ам.
*/

type Schema = {
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean;
  items?: Schema;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  anyOf?: Schema[];
};

const contract = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'contracts', 'desktop-bridge.v2.schema.json'), 'utf8'),
) as Schema & { $defs: Record<string, Schema> };

/** Ровно та часть JSON Schema, что есть в контракте; незнакомое ключевое слово — ошибка теста. */
function errors(value: unknown, schema: Schema, at = '$'): string[] {
  if (schema.$ref) return errors(value, contract.$defs[schema.$ref.replace('#/$defs/', '')]!, at);
  if (schema.anyOf)
    return schema.anyOf.some((option) => errors(value, option, at).length === 0) ? [] : [`${at}: anyOf`];
  const found: string[] = [];
  const fail = (why: string) => found.push(`${at}: ${why}`);
  if ('const' in schema && value !== schema.const) fail(`не ${String(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`${String(value)} не из списка`);
  const kind =
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : Number.isInteger(value)
          ? 'integer'
          : typeof value;
  if (schema.type && !(schema.type === kind || (schema.type === 'number' && kind === 'integer')))
    return [`${at}: ${kind} вместо ${schema.type}`];
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail('короче');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('длиннее');
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) fail('не по образцу');
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) fail('меньше');
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) fail('больше');
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('много');
    if (schema.uniqueItems && new Set(value).size !== value.length) fail('повторы');
    if (schema.items)
      value.forEach((item, index) => found.push(...errors(item, schema.items!, `${at}[${index}]`)));
  }
  if (kind === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in record)) fail(`нет ${key}`);
    for (const [key, item] of Object.entries(record)) {
      const inner = schema.properties?.[key];
      if (inner) found.push(...errors(item, inner, `${at}.${key}`));
      else if (schema.additionalProperties === false) fail(`лишнее ${key}`);
    }
  }
  return found;
}
const def = (name: string) => ({ $ref: `#/$defs/${name}` });

const away: NotifyContext = {
  roomId: '00000000-0000-4000-8000-000000000001',
  title: 'Планёрка',
  focused: false,
  visible: true,
  chatOpen: false,
  selfName: 'Ника',
  canApprove: true,
};

describe('контракт моста v2', () => {
  it('уведомления, которые шлёт веб, проходят проверку оболочки: tag ≤ 60, кнопки, silent', () => {
    const sent = [
      decideNotification(t, { kind: 'knock', name: 'Аня', participantId: 'a', waiting: 1 }, away),
      decideNotification(t, { kind: 'knock', name: 'Аня', participantId: 'a', waiting: 4 }, away),
      decideNotification(t, { kind: 'message', name: 'Миша', text: '@Ника '.repeat(80) }, away),
      decideNotification(t, { kind: 'join', names: ['Я'.repeat(200), 'Оля'] }, away),
    ];
    for (const note of sent) {
      expect(note).not.toBeNull();
      const { attention: _attention, ...payload } = note!;
      expect(errors(payload, def('notify'))).toEqual([]);
      expect(payload.silent).toBe(true);
    }
  });

  it('проверка notify не пропускает лишнего: длинный заголовок, третью кнопку, silent строкой', () => {
    const ok = { title: 'Аня просится во встречу', body: '', tag: 'room:x:knock', silent: true };
    expect(errors(ok, def('notify'))).toEqual([]);
    expect(errors({ ...ok, title: 'Я'.repeat(81) }, def('notify'))).not.toEqual([]);
    expect(errors({ ...ok, silent: 'yes' }, def('notify'))).not.toEqual([]);
    const action = { id: 'admit', text: 'Впустить' };
    expect(errors({ ...ok, actions: [action, action, action] }, def('notify'))).not.toEqual([]);
    expect(errors({ ...ok, actions: [{ id: 'Admit!', text: 'x' }] }, def('notify'))).not.toEqual([]);
  });

  it('значок, мигание и состояние окна', () => {
    expect(errors({ count: 3 }, def('badge'))).toEqual([]);
    expect(errors({ count: -1 }, def('badge'))).not.toEqual([]);
    expect(errors({}, def('attention'))).toEqual([]);
    expect(errors({ focused: false, visible: true }, def('windowState'))).toEqual([]);
    expect(errors({ focused: false }, def('windowState'))).not.toEqual([]);
    expect(errors({ id: 'admit', tag: `room:${away.roomId}:knock` }, def('notificationAction'))).toEqual([]);
  });

  it('имена: веб шлёт notify, badge, attention и слушает window.state и notification.action', () => {
    expect(contract.$defs.pageMessage!.enum).toEqual(
      expect.arrayContaining(['notify', 'badge', 'attention']),
    );
    expect(contract.$defs.hostMessage!.enum).toEqual(
      expect.arrayContaining(['window.state', 'notification.action']),
    );
    expect(contract.$defs.feature!.enum).toEqual(expect.arrayContaining(['notify', 'badge', 'attention']));
  });

  it('Bootstrap.language: язык установщика или null; незнакомый язык — отказ', () => {
    const bootstrap = {
      profile: '',
      theme: 'system',
      language: 'de',
      showPing: false,
      notificationSounds: true,
      autoConnect: true,
    };
    expect(errors(bootstrap, def('bootstrap'))).toEqual([]);
    expect(errors({ ...bootstrap, language: null }, def('bootstrap'))).toEqual([]);
    expect(errors({ ...bootstrap, language: 'xx' }, def('bootstrap'))).not.toEqual([]);
    const { language: _language, ...older } = bootstrap;
    expect(errors(older, def('bootstrap'))).not.toEqual([]);
  });
});

describe('язык из установщика (R64)', () => {
  it('preload кладёт его в настройки, пока человек язык не выбирал, — и веб берёт его до языка браузера', () => {
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ language: 'de' }));
    expect(detectLanguage(readPreferences().language, ['it-IT'])).toBe('de');
  });

  it('свой выбор человека важнее: preload его не перебивает, и веб берёт его', () => {
    localStorage.setItem('cord:preferences:v1', JSON.stringify({ language: 'it' }));
    expect(detectLanguage(readPreferences().language, ['de-DE'])).toBe('it');
  });

  it('без выбора и без установщика — язык браузера', () => {
    localStorage.removeItem('cord:preferences:v1');
    expect(detectLanguage(readPreferences().language, ['fr-FR'])).toBe('fr');
  });
});

/*
  Трей клиента Windows (R103): меню трея говорит на языке интерфейса страницы (`state.language`),
  «Чат · N» открывает чат встречи (`chat.open`), «Уведомления» — переключатель оболочки
  (`app.settings.notifications`), а состояние сочетаний приходит кодами. Имена и коды сверены с
  веткой оболочки (`desktop/src/shared/bridge.ts`, `src/main/tray-menu.ts`, `hotkeys.ts`).
*/
describe('трей (R103)', () => {
  const meeting = {
    ended: { get: () => false },
    admission: {
      roomId: '00000000-0000-4000-8000-000000000001',
      snapshot: { title: 'Планёрка', code: '123456789' },
    },
  } as unknown as Meeting;
  const base = { name: 'Ника', theme: 'dark', avatar: '' };

  it('state несёт язык интерфейса и проходит проверку оболочки — на главной и во встрече', () => {
    const home = desktopPageState({ ...base, page: 'home', meeting: null, language: 'de' });
    expect(home).toEqual({ ...base, page: 'home', inCall: false, room: null, language: 'de' });
    expect(errors(home, def('state'))).toEqual([]);
    const room = desktopPageState({ ...base, page: 'room', meeting, language: 'zh-Hans' });
    expect(room).toMatchObject({ inCall: true, language: 'zh-Hans', room: { code: '123456789' } });
    expect(errors(room, def('state'))).toEqual([]);
  });

  it('незнакомый язык не уходит вовсе — оболочка тогда берёт язык установщика или Windows', () => {
    for (const language of [undefined, 'xx', 'cimode']) {
      const state = desktopPageState({ ...base, page: 'prejoin', meeting: null, language });
      expect(state).not.toHaveProperty('language');
      expect(errors(state, def('state'))).toEqual([]);
    }
    expect(
      errors(
        { ...desktopPageState({ ...base, page: 'home', meeting: null, language: 'ru' }), language: 'xx' },
        def('state'),
      ),
    ).not.toEqual([]);
  });

  it('язык берётся из i18next как есть (resolvedLanguage) — это коды контракта, и pt-BR, и zh-Hans', async () => {
    for (const language of ['pt-BR', 'zh-Hans', 'ru'] as const) {
      await applyLanguage(language);
      const state = desktopPageState({
        ...base,
        page: 'home',
        meeting: null,
        language: i18next.resolvedLanguage,
      });
      expect(state.language).toBe(language);
      expect(errors(state, def('state'))).toEqual([]);
    }
  });

  it('chat.open — событие оболочки без нагрузки', () => {
    expect(contract.$defs.hostMessage!.enum).toContain('chat.open');
    expect(errors({}, def('chatOpen'))).toEqual([]);
    expect(errors({ unread: 3 }, def('chatOpen'))).not.toEqual([]);
  });

  it('app.settings знает notifications; чужой ключ и не логическое значение — отказ', () => {
    expect(errors({ notifications: false }, def('appSettings'))).toEqual([]);
    expect(errors({ notifications: 'off' }, def('appSettings'))).not.toEqual([]);
    expect(errors({ sounds: true }, def('appSettings'))).not.toEqual([]);
  });

  it('hotkeys.status — {status: {действие: код}}; каждый код оболочки веб понимает', () => {
    const codes = contract.$defs.hotkeyStatusCode!.enum as HotkeyStatus[];
    expect(codes).toEqual(['global', 'global-raw', 'taken', 'duplicate', 'window-only']);
    expect(
      errors(
        { status: { 'mic.toggle': 'global', ptt: 'global-raw', 'overlay.toggle': 'taken' } },
        def('hotkeysStatus'),
      ),
    ).toEqual([]);
    // Русская фраза оболочки 1.0.4 — уже не по контракту.
    expect(errors({ status: { 'mic.toggle': 'Сочетание отключено' } }, def('hotkeysStatus'))).not.toEqual([]);
    expect(errors({ status: { 'mic.mute': 'global' } }, def('hotkeysStatus'))).not.toEqual([]);
    // О том, что мешает, веб говорит словами; о норме молчит.
    const spoken = codes.filter((code) => hotkeyStatusText(t, code) !== null);
    expect(spoken).toEqual(['taken', 'duplicate', 'window-only']);
  });
});

describe('оверлей в игре, игры и мини-окно (R62, R63, R93, R104)', () => {
  it('имена: веб шлёт overlay.roster и mini.state, зовёт games.*, слушает games.changed, game.active, mini.action, golive', () => {
    expect(contract.$defs.feature!.enum).toEqual(
      expect.arrayContaining(['games', 'overlay.widget', 'mini', 'golive']),
    );
    expect(contract.$defs.pageMessage!.enum).toEqual(
      expect.arrayContaining(['overlay.roster', 'mini.state']),
    );
    expect(contract.$defs.pageCall!.enum).toEqual(
      expect.arrayContaining(['games.list', 'games.set', 'games.forget', 'games.pick']),
    );
    expect(contract.$defs.hostMessage!.enum).toEqual(
      expect.arrayContaining(['games.changed', 'game.active', 'mini.action', 'golive']),
    );
  });

  it('состав и уровни: до 25 человек, аватар только data:image, уровень — тройкой', () => {
    const person = {
      id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      name: 'Аня',
      avatar: 'data:image/png;base64,AAAA',
      muted: true,
    };
    expect(
      errors(
        { participants: [person, { id: 'p-2', name: 'Миша', avatar: '', muted: false }] },
        def('overlayRoster'),
      ),
    ).toEqual([]);
    expect(
      errors({ participants: [{ ...person, avatar: 'https://evil/a.png' }] }, def('overlayRoster')),
    ).not.toEqual([]);
    expect(
      errors(
        { participants: Array.from({ length: 26 }, (_, i) => ({ ...person, id: `p-${i}` })) },
        def('overlayRoster'),
      ),
    ).not.toEqual([]);
    expect(errors({ levels: [['p-2', 3, 0.6]] }, def('overlayLevels'))).toEqual([]);
  });

  it('мини-окно: состояние и нажатия', () => {
    expect(
      errors(
        { room: 'Пятница', self: 'p-1', mic: true, camera: false, screen: false, unread: 2, count: 2 },
        def('miniState'),
      ),
    ).toEqual([]);
    expect(errors({ status: 'recovering', remaining: 12 }, def('miniState'))).toEqual([]);
    expect(
      errors({ status: 'ended' }, def('miniState')),
      'конец встречи — не состояние мини-окна',
    ).not.toEqual([]);
    expect(errors({ unread: -1 }, def('miniState'))).not.toEqual([]);
    expect(errors({ id: 'mic' }, def('miniAction'))).toEqual([]);
    expect(errors({ id: 'record' }, def('miniAction')), 'записи в Cord нет').not.toEqual([]);
  });

  it('мини-окно (R137): нажатие с нужным состоянием и номером, ответ mini.ack, повтор по mini.resync', () => {
    expect(contract.$defs.pageMessage!.enum).toEqual(expect.arrayContaining(['mini.ack']));
    expect(contract.$defs.hostMessage!.enum).toEqual(expect.arrayContaining(['mini.resync']));
    expect(errors({ id: 'mic', want: false, seq: 12 }, def('miniAction'))).toEqual([]);
    expect(errors({ id: 'mic', want: 'off' }, def('miniAction'))).not.toEqual([]);
    expect(errors({ id: 'mic', seq: -1 }, def('miniAction'))).not.toEqual([]);
    expect(errors({ seq: 12, result: 'ok' }, def('miniAck'))).toEqual([]);
    expect(errors({ seq: 12, result: 'ignored', reason: 'link' }, def('miniAck'))).toEqual([]);
    expect(errors({ seq: 12, result: 'maybe' }, def('miniAck'))).not.toEqual([]);
    expect(errors({ result: 'ok' }, def('miniAck')), 'без номера').not.toEqual([]);
    expect(
      errors({ seq: 1, result: 'ignored', reason: 'Нет связи' }, def('miniAck')),
      'причина — код',
    ).not.toEqual([]);
    expect(errors({ room: 'Пятница', seq: 3 }, def('miniState'))).toEqual([]);
    expect(errors({ seq: 1.5 }, def('miniState'))).not.toEqual([]);
    expect(errors({}, def('miniResync'))).toEqual([]);
  });

  it('app.settings: мини-окно и виджет — свои значения; прозрачность 30–100', () => {
    const widget = {
      mini: true,
      overlayCorner: 'br',
      overlaySize: 'l',
      overlayNames: 'speaking',
      overlayOpacity: 30,
      overlayToast: false,
    };
    expect(errors(widget, def('appSettings'))).toEqual([]);
    expect(errors({ overlayOpacity: 101 }, def('appSettings'))).not.toEqual([]);
    expect(errors({ overlayCorner: 'center' }, def('appSettings'))).not.toEqual([]);
  });

  it('игры и «Показать игру»', () => {
    const cs2 = { exe: 'cs2.exe', name: 'Counter-Strike 2', enabled: true, firstSeen: 1, lastSeen: 2 };
    const active = { exe: 'cs2.exe', name: 'Counter-Strike 2', enabled: true, exclusive: false };
    expect(errors({ games: [cs2], active }, def('games'))).toEqual([]);
    expect(errors({ games: [], active: null }, def('games'))).toEqual([]);
    expect(errors({ games: [{ ...cs2, exe: 'C:\\cs2.exe' }], active: null }, def('games'))).not.toEqual([]);
    expect(errors({ game: null }, def('gameActive'))).toEqual([]);
    expect(errors({ id: 'window:1234:0', name: 'Counter-Strike 2' }, def('golive'))).toEqual([]);
    expect(errors({ id: 'screen:1:0' }, def('golive')), 'показать игру — только окно').not.toEqual([]);
  });

  it('hotkeys.status знает разблокировку оверлея', () => {
    expect(errors({ status: { 'overlay.lock': 'global-raw' } }, def('hotkeysStatus'))).toEqual([]);
  });
});

describe('видеокарта и аппаратный AV1 (R152)', () => {
  const answer = {
    devices: [
      {
        vendorId: 0x10de,
        deviceId: 0x2786,
        name: 'NVIDIA GeForce RTX 4070',
        driver: '32.0.15.6094',
        active: true,
      },
      { vendorId: 0x8086, deviceId: 0x46a0, name: '', driver: '', active: false },
    ],
    encoders: null,
    av1hw: { enabled: true, allowed: true },
  };

  it('имена: флаги app.gpu и codec.av1hw, запрос app.gpu', () => {
    expect(contract.$defs.feature!.enum).toEqual(expect.arrayContaining(['app.gpu', 'codec.av1hw']));
    expect(contract.$defs.pageCall!.enum).toContain('app.gpu');
  });

  it('ответ оболочки проходит схему, и веб читает из него поставщиков и ключ AV1', () => {
    expect(errors(answer, def('appGpu'))).toEqual([]);
    expect(errors({ ...answer, encoders: ['av1', 'h264'] }, def('appGpu'))).toEqual([]);
    expect(errors({ ...answer, encoders: ['hevc'] }, def('appGpu'))).not.toEqual([]);
    expect(errors({ ...answer, av1hw: { enabled: true } }, def('appGpu'))).not.toEqual([]);
    expect(parseShellGpu(answer)).toEqual({
      vendors: ['nvidia', 'intel'],
      av1hw: true,
      source: 'shell',
      identity: 'nvidia:2786:NVIDIA GeForce RTX 4070/32.0.15.6094;intel:46a0:/',
    });
    // Старая оболочка или чужой ответ — подсказки нет, веб спросит WebGL.
    expect(parseShellGpu(null)).toBeNull();
    expect(parseShellGpu({ devices: 'x' })).toBeNull();
  });
});

/*
  Общие настройки (R146, Р-39): то, что шлёт `core/shared-preferences.ts`, проходит схему оболочки —
  она отказывает всему сообщению за чужой ключ, тип или размер (`messages.ts`, validSharedValue).
*/
describe('общие настройки для всех серверов (R146)', () => {
  it('флаг prefs.shared, протокол minor 1, Bootstrap.shared и yandexMusicToken', () => {
    expect(contract.$defs.feature!.enum).toContain('prefs.shared');
    const bootstrap = {
      profile: '',
      theme: 'system',
      language: null,
      showPing: false,
      notificationSounds: true,
      autoConnect: true,
      shared: { name: 'Ника', deafened: true, devices: { microphone: 'USB Mic' } },
      yandexMusicToken: 'y0_AgAAAA',
    };
    expect(errors(bootstrap, def('bootstrap'))).toEqual([]);
    expect(errors({ ...bootstrap, yandexMusicToken: null, shared: {} }, def('bootstrap'))).toEqual([]);
    expect(
      errors({ ...bootstrap, shared: { favorites: [] } }, def('bootstrap')),
      'избранное — своё у сервера',
    ).not.toEqual([]);
    expect(errors({ ...bootstrap, yandexMusicToken: 't'.repeat(1001) }, def('bootstrap'))).not.toEqual([]);
    expect(errors({ major: 2, minor: 1 }, def('protocol'))).toEqual([]);
  });

  it('preferences.changed {shared, seed}: записи {value, at}, белый список ключей', async () => {
    const { sharedValues } = await import('./shared-preferences');
    const values = sharedValues(readPreferences());
    const shared = Object.fromEntries(
      Object.entries({ ...values, yandexMusicToken: 'y0_AgAAAA', devices: { camera: 'HD Webcam' } }).map(
        ([key, value]) => [key, { value, at: 1_793_451_200_000 }],
      ),
    );
    expect(errors({ shared, seed: true }, def('preferencesChanged'))).toEqual([]);
    for (const [key, entry] of Object.entries(shared))
      if (key !== 'yandexMusicToken' && key !== 'devices')
        expect(errors({ [key]: entry.value }, def('sharedValues')), key).toEqual([]);
    expect(errors({ showPing: true, notificationSounds: false }, def('preferencesChanged'))).toEqual([]);
    expect(errors({ shared: { favorites: { value: [], at: 1 } } }, def('preferencesChanged'))).not.toEqual(
      [],
    );
    expect(
      errors({ shared: { name: { value: 'Ника' } } }, def('preferencesChanged')),
      'без времени',
    ).not.toEqual([]);
    expect(errors({ shared: {}, seed: 'yes' }, def('preferencesChanged'))).not.toEqual([]);
  });

  it('фон в видео (R153) — общий: размытие, встроенный фон или своё фото; чужой вид — отказ', () => {
    for (const background of [
      { kind: 'none' },
      { kind: 'blur', strength: 'strong' },
      { kind: 'image', id: 'custom' },
    ])
      expect(errors({ background }, def('sharedValues')), JSON.stringify(background)).toEqual([]);
    expect(errors({ background: { kind: 'video' } }, def('sharedValues'))).not.toEqual([]);
    expect(errors({ background: { kind: 'image', url: 'https://x' } }, def('sharedValues'))).not.toEqual([]);
  });

  it('«Звук встречи» (R156): mini.state.deafened и нажатие deafen', () => {
    expect(errors({ room: 'Пятница', deafened: true }, def('miniState'))).toEqual([]);
    expect(errors({ deafened: 'yes' }, def('miniState'))).not.toEqual([]);
    expect(errors({ id: 'deafen', want: true, seq: 4 }, def('miniAction'))).toEqual([]);
  });
});
