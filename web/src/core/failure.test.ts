import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { i18next } from '../i18n';
import {
  classify,
  failureText,
  flush,
  FriendlyError,
  noteFailure,
  OfflineError,
  pendingFailures,
  resetFailures,
  startFailureReports,
  watchFailures,
} from './failure';
import { flush as flushInsight, resetInsightForTest } from './insight';
import { recentErrors } from './support';

/*
  Одна точка перевода ошибок для человека (R180): что бы ни бросили браузер, LiveKit, ядро или служба,
  человек видит фразу на своём языке — без портов, кодов и английских слов; техника — в журнал и счёт.
*/

const dom = (name: string, message = 'technical words') => new DOMException(message, name);

beforeEach(() => {
  resetFailures();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('фраза для человека', () => {
  it('отказ ядра с кодом из реестра — его текстом', () => {
    const error = new ApiError(409, 'ROOM_FULL', 'Во встрече нет свободных мест (предел — 20)');
    expect(failureText(error, 'join')).toBe('Во встрече нет свободных мест (предел — 20)');
    expect(classify(error, 'join').code).toBe('ROOM_FULL');
  });

  it('отказ службы без кода по-русски — её словами, английское слово FastAPI — общей фразой места', () => {
    const said = new ApiError(409, 'REQUEST_FAILED', 'В очереди уже 100 треков', {
      detail: 'В очереди уже 100 треков',
    });
    expect(failureText(said, 'music')).toBe('В очереди уже 100 треков');
    const english = new ApiError(404, 'REQUEST_FAILED', 'Not Found', { detail: 'Not Found' });
    expect(failureText(english, 'music')).toBe('Музыка не ответила — попробуйте ещё раз');
    const list = new ApiError(422, 'REQUEST_FAILED', 'Проверьте данные запроса', { detail: [{ msg: 'x' }] });
    expect(failureText(list, 'cinema')).toBe('Кинозал не ответил — попробуйте ещё раз');
  });

  it('на другом языке русскую фразу службы без кода не показывает', async () => {
    await i18next.changeLanguage('en');
    try {
      const said = new ApiError(409, 'REQUEST_FAILED', 'В очереди уже 100 треков', {
        detail: 'В очереди уже 100 треков',
      });
      expect(failureText(said, 'music')).not.toMatch(/[а-яё]/i);
    } finally {
      await i18next.changeLanguage('ru');
    }
  });

  it('сервер за прокси молчит (502 без тела) — «сервер недоступен», сбой 500 — общая фраза места', () => {
    expect(failureText(new ApiError(502, 'REQUEST_FAILED', 'Не удалось выполнить запрос'), 'board')).toBe(
      'Сервер сейчас недоступен — попробуйте через минуту',
    );
    expect(failureText(new ApiError(500, 'REQUEST_FAILED', 'Не удалось выполнить запрос'), 'board')).toBe(
      'Доска не ответила — попробуйте ещё раз',
    );
  });

  it('обрыв сети и срок — словами, а не «Failed to fetch» и «signal timed out»', () => {
    expect(failureText(new TypeError('Failed to fetch'), 'favorites')).toBe(
      'Нет связи с сервером — попробуйте ещё раз',
    );
    expect(failureText(new OfflineError('x'), 'favorites')).toBe('Нет связи с сервером — попробуйте ещё раз');
    expect(failureText(dom('TimeoutError', 'signal timed out'), 'favorites')).toBe(
      'Сервер не ответил вовремя — попробуйте ещё раз',
    );
  });

  it('отказ браузера в устройстве — что с устройством и что сделать', () => {
    expect(failureText(dom('NotAllowedError', 'Permission denied'), 'camera')).toBe(
      'Нет доступа к камере — разрешите его для Cord в браузере или в настройках системы',
    );
    expect(failureText(dom('NotFoundError', 'Requested device not found'), 'microphone')).toBe(
      'Микрофон не найден — проверьте, что он подключён',
    );
    expect(failureText(dom('NotReadableError', 'Could not start video source'), 'camera')).toBe(
      'Камера занята другой программой или не запускается — закройте её там и попробуйте ещё раз',
    );
    expect(classify(dom('NotAllowedError'), 'camera').code).toBe('denied');
  });

  it('отказ в разрешении вне устройств — общая фраза места', () => {
    expect(failureText(dom('NotAllowedError', 'Write permission denied.'), 'chat')).toBe(
      'Сообщение не отправилось — попробуйте ещё раз',
    );
  });

  it('ошибка LiveKit — не её английский текст, а фраза места', () => {
    const error = Object.assign(new Error('could not establish pc connection'), { name: 'ConnectionError' });
    expect(failureText(error, 'call')).toBe('Звук и видео пока не подключились — пробуем ещё раз');
    expect(classify(error, 'call').code).toBe('call');
  });

  it('ошибка в коде — общая фраза места или своя фраза вызова', () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'id')");
    expect(failureText(bug, 'board')).toBe('Доска не ответила — попробуйте ещё раз');
    expect(failureText(bug, 'board', 'Не удалось сохранить доску в чат')).toBe(
      'Не удалось сохранить доску в чат',
    );
    expect(classify(bug, 'board').code).toBe('bug');
  });

  it('своя фраза Cord (`FriendlyError`) — как есть, обычный `Error` с чужим текстом — нет', () => {
    expect(failureText(new FriendlyError('Комната больше не в избранном'), 'favorites')).toBe(
      'Комната больше не в избранном',
    );
    expect(failureText(new Error('png failed'), 'board')).toBe('Доска не ответила — попробуйте ещё раз');
  });
});

describe('учёт', () => {
  it('журнал браузера с местом и кодом, недавние ошибки и счёт по паре «место — код»', () => {
    const warn = vi.mocked(console.warn);
    failureText(dom('NotAllowedError'), 'camera');
    failureText(dom('NotAllowedError'), 'camera');
    failureText(new ApiError(409, 'ROOM_FULL', 'Во встрече нет свободных мест'), 'join');
    expect(warn).toHaveBeenCalledWith('[cord] camera failed: denied', expect.any(DOMException));
    expect(recentErrors().at(-1)).not.toMatch(/ROOM_FULL/); // отказ сервера — уже в кольце со своим адресом
    expect(
      recentErrors().some((line) => line.endsWith('camera denied NotAllowedError: technical words')),
    ).toBe(true);
    expect(pendingFailures()).toEqual([
      { place: 'camera', code: 'denied', count: 2 },
      { place: 'join', code: 'ROOM_FULL', count: 1 },
    ]);
  });

  it('в ошибки аналитики не идут ходы по правилам игр и отметки «восстановилось»; сам сбой — идёт', async () => {
    const sent = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', sent);
    resetInsightForTest();
    noteFailure('games', 'DURAK_TURN');
    noteFailure('camera', 'camera-healed');
    noteFailure('cinema', 'cinema-healed');
    noteFailure('camera', 'camera-stalled');
    await flushInsight();
    const codes = sent.mock.calls
      .filter(([url]) => url === '/api/v1/t')
      .flatMap(
        ([, init]) =>
          (JSON.parse(String(init?.body)) as { events: { n: string; p: { code?: string } }[] }).events,
      )
      .filter((event) => event.n === 'error')
      .map((event) => event.p.code);
    expect(codes).toEqual(['camera-stalled']);
    vi.unstubAllGlobals();
    resetInsightForTest();
  });

  it('незнакомый код — `other`: метка счётчика только из известного списка', () => {
    noteFailure('board', 'SOMETHING_NEW');
    noteFailure('board', 'free text with spaces');
    expect(pendingFailures()).toEqual([{ place: 'board', code: 'other', count: 2 }]);
  });

  it('сводка уходит раз в 30 с и при уходе со страницы; не дошла — счёт возвращается', async () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    let online = false;
    startFailureReports(async (batch, keepalive) => {
      sent.push({ batch, keepalive });
      return online;
    });
    noteFailure('chat', 'offline');
    await vi.advanceTimersByTimeAsync(29_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([{ batch: [{ place: 'chat', code: 'offline', count: 1 }], keepalive: false }]);
    expect(pendingFailures()).toEqual([{ place: 'chat', code: 'offline', count: 1 }]);
    online = true;
    noteFailure('chat', 'offline');
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.at(-1)).toEqual({ batch: [{ place: 'chat', code: 'offline', count: 2 }], keepalive: true });
    expect(pendingFailures()).toEqual([]);
    await flush(false);
    expect(sent).toHaveLength(2);
  });

  it('необработанная ошибка страницы — `app bug`, шум ResizeObserver и отмена — нет', () => {
    const target = new EventTarget() as Window;
    watchFailures(target);
    target.dispatchEvent(Object.assign(new Event('error'), { message: 'ResizeObserver loop completed' }));
    const rejection = (reason: unknown) =>
      target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }));
    rejection(dom('AbortError'));
    expect(pendingFailures()).toEqual([]);
    target.dispatchEvent(
      Object.assign(new Event('error'), {
        message: 'x is not a function',
        error: new TypeError('x is not a function'),
      }),
    );
    rejection(new TypeError('Failed to fetch'));
    expect(pendingFailures()).toEqual([
      { place: 'app', code: 'bug', count: 1 },
      { place: 'app', code: 'offline', count: 1 },
    ]);
  });
});

describe('каталог', () => {
  /*
    Техника пути и протоколов — только в «Диагностике», на странице владельца сервера («Активность»)
    и в названиях путей, которые показывает та же «Диагностика» (`media.link.paths`). Всё остальное
    человек читает как фразу: плашка «Сеть не пропускает звонок» с «портом 443» и «TURN» — то, что
    владелец назвал непонятным (R180).
  */
  // Сокращения — с учётом регистра (TURN — не «Turn on»), «порт» — в любом регистре и падеже.
  const ACRONYMS =
    /\b(443|TURN|ICE|TLS|UDP|TCP|WebRTC|WebSocket|HTTP|JSON|SFU|RTT|DRM|DASH|LiveKit|yt-dlp)\b/u;
  const PORT =
    /(?<![\u0430-\u044f\u0451])\u043f\u043e\u0440\u0442(\u0430|\u0443|\u043e\u043c)?(?![\u0430-\u044f\u0451])|(?<!\p{L})ports?(?!\p{L})/iu;
  const technical = (text: string) => ACRONYMS.test(text) || PORT.test(text);
  const ALLOWED = ['diagnostics.', 'activity.', 'media.link.paths.'];
  const locales = import.meta.glob<Record<string, unknown>>('../i18n/locales/*.json', {
    eager: true,
    import: 'default',
  });

  function strings(node: unknown, path = ''): [string, string][] {
    if (typeof node === 'string') return [[path, node]];
    if (!node || typeof node !== 'object') return [];
    return Object.entries(node).flatMap(([key, value]) => strings(value, path ? `${path}.${key}` : key));
  }

  it('порты, протоколы и имена библиотек — только в «Диагностике» и у владельца', () => {
    const found = Object.entries(locales).flatMap(([file, catalog]) =>
      strings(catalog)
        .filter(([path, text]) => !ALLOWED.some((prefix) => path.startsWith(prefix)) && technical(text))
        .map(([path, text]) => `${file.split('/').pop()} ${path}: ${text}`),
    );
    expect(found).toEqual([]);
  });
});
