import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, type Route } from '@playwright/test';

/**
 * Кинозал без площадок: служба отвечает записанным, а видео — своё.
 *
 * ПОЧЕМУ ЗАПИСЬ. Живые YouTube и Twitch для проверки не годятся: выдача и обложки меняются
 * каждый час, эфиры кончаются, а YouTube время от времени отказывает серверу в разборе ролика
 * («Sign in to confirm you're not a bot»). Сценарий, который падает от настроения площадки,
 * ничего не доказывает. Поэтому здесь каждый запрос каталога получает настоящий ответ службы,
 * снятый с прода 24.09.2026 (`fixtures/cinema/`), а поток — двенадцать секунд своего HLS
 * (`fixtures/hls/`, две ступени: 180p и 144p). Служба для этого не нужна вовсе — сценарии
 * идут и в CI, где её нет.
 *
 * ЧТО ЗАПИСАНО. YouTube: пустой запрос, поиски «big buck bunny» и «never gonna give you up»,
 * канал Blender (вкладки «Видео» с продолжением, «Плейлисты», «О канале»), его плейлист,
 * страница ролика и поток `dQw4w9WgXcQ` — единственного ролика, который площадка в тот день
 * разобрала серверу. Twitch: витрина эфиров, «Категории», раздел Just Chatting, эфир и канал
 * `pesh`. Ленты обрезаны до двенадцати карточек и на этом кончаются; у ленты канала есть
 * вторая страница (`cursor=30`, шесть карточек) — ради «Показать ещё». Все картинки —
 * одна серая `/fixtures/poster.png`.
 *
 * КАК ОТВЕЧАЕТ. Ближайшей записью: любой канал — каналом Blender (или `pesh` у Twitch),
 * любой плейлист и раздел — записанным, незнакомый запрос YouTube — выдачей «big buck bunny».
 * Страница и поток незнакомого ролика — записанные, но с лицом его собственной карточки (id,
 * название, автор, длительность, обложка), чтобы плеер и страница показывали то, что нажато.
 * Листание дальше записанного и поиск по Twitch отвечают пустой лентой, как служба на конце
 * списка. Неизвестный маршрут — 404, как у FastAPI: новый маршрут сценарий обязан ответить
 * сам, через `overrides`.
 *
 * ССЫЛКА (`POST …/cinema/link`). Чья ссылка, решает грамматика площадок в службе, и её держат тесты
 * службы (`services/tests/test_cinema_links.py`); здесь — только формы, которыми пользуются
 * сценарии, с тем же ответом, что дала бы служба: своя площадка — `route`, чужая — причина словами.
 */
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const CINEMA = /^\/api\/v1\/services\/rooms\/[^/]+\/cinema\/(.+)$/;
const END = { items: [], next: null };
/** Столько живёт подпись у настоящей службы; от «сейчас», иначе плеер пошёл бы её обновлять. */
const SIGNATURE_MS = 5 * 3600 * 1000;
const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m2ts': 'video/mp2t',
  '.png': 'image/png',
  '.vtt': 'text/vtt; charset=utf-8',
};

type Json = Record<string, unknown>;

/** Строка времени реплики SRT: `00:00:07,120 --> 00:00:17,240` и, может быть, положение реплики. */
const TIMING =
  /^\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})(.*)$/;

/**
 * Субтитры площадки в SRT — WebVTT по дороге, как их отдаёт браузеру маршрут службы `subtitles`.
 *
 * Служба в сценарии не участвует, и её перевод здесь играет перехват — тем же правилом, что
 * `cord_services/cinema/captions.py` (`webvtt`): первая строка `WEBVTT`, точка вместо запятой в
 * долях секунды и две цифры часов — только в строках времени; запятая в самой реплике остаётся
 * запятой. Сам перевод проверяют тесты службы; здесь — что плеер показывает то, что она отдаёт.
 */
function webvtt(text: string): string {
  const stamp = (hours: string, minutes: string, seconds: string, fraction: string) =>
    `${hours.padStart(2, '0')}:${minutes}:${seconds}.${fraction.padEnd(3, '0')}`;
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const found = TIMING.exec(line);
      if (!found) return line;
      const [, h1, m1, s1, f1, h2, m2, s2, f2, rest] = found as unknown as string[];
      return `${stamp(h1!, m1!, s1!, f1!)} --> ${stamp(h2!, m2!, s2!, f2!)}${rest}`;
    });
  return 'WEBVTT\n\n' + lines.join('\n').replace(/^\n+/, '');
}

/** Записанный ответ службы по имени файла из `fixtures/cinema/`. Каждый раз — свежая копия. */
export function fixture<T = Json>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURES, 'cinema', `${name}.json`), 'utf8')) as T;
}

/** Запрос к кинозалу, как его видит обработчик: маршрут, параметры и тело. */
export interface CinemaCall {
  endpoint: string;
  method: string;
  params: URLSearchParams;
  body: Json | null;
}

/** Ответ не `200`: `return reply(502, { detail: '…' })` из обработчика. */
export class CinemaReply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
export const reply = (status: number, body: unknown) => new CinemaReply(status, body);

/**
 * Свой ответ на маршрут: тело (`200`), {@link reply} с другим кодом или `undefined` — тогда
 * отвечает запись. Ключ — путь после `/cinema/` (`search`, `resolve`, `providers`,
 * `accounts/rutube`, …) и `catalog` для каталога служб.
 */
export type CinemaHandler = (call: CinemaCall) => unknown;
export type CinemaOverrides = Record<string, CinemaHandler>;

const SEARCHES: Record<string, string> = {
  'big buck bunny': 'youtube-search-big-buck-bunny',
  'never gonna give you up': 'youtube-search-never-gonna-give-you-up',
};
const DETAILS: Record<string, string> = {
  'youtube:video': 'youtube-details',
  'twitch:channel': 'twitch-details',
};
/** Что берётся у карточки, когда страница или поток отвечают за незнакомый ролик. */
const FACE = ['title', 'author', 'channelId', 'duration', 'live', 'views', 'viewers', 'category', 'poster'];

let cards: Map<string, Json> | undefined;
/** Все карточки из записанных лент — по `provider:id`. */
function card(provider: string, id: string): Json | undefined {
  if (!cards) {
    cards = new Map();
    const lists = [
      'youtube-search-big-buck-bunny',
      'youtube-search-never-gonna-give-you-up',
      'youtube-channel-videos',
      'youtube-channel-videos-30',
      'youtube-playlist',
      'twitch-search',
      'twitch-category',
      'twitch-channel-videos',
    ];
    for (const name of lists) {
      const page = fixture<{ items: Json[]; channels?: Json[] }>(name);
      for (const item of [...page.items, ...(page.channels ?? [])])
        if (!cards.has(`${item.provider}:${item.id}`)) cards.set(`${item.provider}:${item.id}`, item);
    }
  }
  return cards.get(`${provider}:${id}`);
}

/** Лицо карточки поверх записанного ответа — только те поля, что в ответе и так есть. */
function wear(recorded: Json, id: string, provider: string): Json {
  const face = card(provider, id);
  const worn: Json = { ...recorded };
  for (const key of FACE) if (face && key in face && key in recorded) worn[key] = face[key];
  return worn;
}

function exists(name: string) {
  return existsSync(path.join(FIXTURES, 'cinema', `${name}.json`));
}

/**
 * Площадки включены и отвечают — все шесть, тем же набором возможностей, что называет служба
 * (`cord_services/cinema/providers/{youtube,twitch,rutube,vk,ivi,link}.py`). Не запись: сама проверка
 * доступности бьёт наружу, а здесь площадки нет вовсе, — поэтому ответ собран руками, а не снят
 * с прода. Каталогу Rutube и VK по записям отвечают сами сценарии `cinema-rutube.spec.ts` и
 * `cinema-vk.spec.ts` — своими `overrides`.
 *
 * Панель показывает только площадки из этого ответа: какой здесь нет, той нет и на экране (так
 * выглядит установка с `CINEMA_PROVIDERS`). Сценарий с выключенной площадкой берёт этот список и
 * убирает из него лишнее сам ({@link providersAnswer}).
 */
export const PROVIDERS_ANSWER = {
  providers: [
    {
      id: 'youtube',
      available: true,
      reason: null,
      account: 'none',
      connected: false,
      features: {
        search: true,
        channels: true,
        playlists: true,
        categories: false,
        series: false,
        live: true,
      },
    },
    {
      id: 'twitch',
      available: true,
      reason: null,
      account: 'none',
      connected: false,
      features: {
        search: true,
        channels: true,
        playlists: false,
        categories: true,
        series: false,
        live: true,
      },
    },
    {
      id: 'rutube',
      available: true,
      reason: null,
      account: 'none',
      connected: false,
      features: {
        search: true,
        channels: true,
        playlists: false,
        categories: true,
        series: true,
        live: true,
      },
    },
    {
      id: 'vk',
      available: true,
      reason: null,
      account: 'none',
      connected: false,
      features: {
        search: true,
        channels: true,
        playlists: true,
        categories: true,
        series: false,
        live: true,
      },
    },
    {
      id: 'ivi',
      available: true,
      reason: null,
      account: 'none',
      connected: false,
      features: {
        search: true,
        channels: false,
        playlists: false,
        categories: true,
        series: true,
        live: false,
      },
    },
    {
      id: 'link',
      available: true,
      reason: null,
      account: 'none',
      connected: false,
      features: {
        search: false,
        channels: false,
        playlists: false,
        categories: false,
        series: true,
        live: true,
      },
    },
  ],
};

/**
 * Ответ `GET providers` установки, где площадки `off` выключены (`CINEMA_PROVIDERS`), а у площадок из
 * `down` проверка доступности ответила «нет» с этой причиной.
 */
export function providersAnswer(off: string[] = [], down: Record<string, string> = {}) {
  return {
    providers: PROVIDERS_ANSWER.providers
      .filter((entry) => !off.includes(entry.id))
      .map((entry) =>
        entry.id in down ? { ...entry, available: false, reason: down[entry.id] ?? null } : entry,
      ),
  };
}

/** Ответ службы на ссылку своей площадки. */
interface LinkRoute {
  provider: string;
  kind: string;
  id: string;
  page: string;
}
const route = (provider: string, kind: string, page: string) => (found: RegExpExecArray) => ({
  route: { provider, kind, id: found[1]!, page } satisfies LinkRoute,
});
/** Формы ссылок из сценариев — ровно как их узнаёт служба (`Provider.match`). */
const LINKS: [RegExp, (found: RegExpExecArray) => { route: LinkRoute }][] = [
  [/^https:\/\/youtu\.be\/([\w-]{11})$/, route('youtube', 'video', 'item')],
  [/^https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})$/, route('youtube', 'video', 'item')],
  [/^https:\/\/www\.twitch\.tv\/(\w{3,25})$/, route('twitch', 'channel', 'item')],
  [/^https:\/\/rutube\.ru\/video\/([0-9a-f]{32})\/$/, route('rutube', 'video', 'item')],
  [/^https:\/\/rutube\.ru\/live\/video\/([0-9a-f]{32})\/$/, route('rutube', 'channel', 'item')],
  [/^https:\/\/rutube\.ru\/metainfo\/tv\/([0-9]+)\/$/, route('rutube', 'series', 'series')],
  [/^https:\/\/(?:vk\.com|vkvideo\.ru)\/video(-?[0-9]+_[0-9]+)$/, route('vk', 'video', 'item')],
  [/^https:\/\/live\.vkvideo\.ru\/(\w+)$/, route('vk', 'channel', 'item')],
  [/^https:\/\/(?:www\.)?ivi\.ru\/watch\/([0-9]{1,12})$/, route('ivi', 'video', 'item')],
];
export const UNKNOWN_LINK =
  'Эту ссылку пока не открыть: кинозал узнаёт ссылки YouTube, Twitch, Rutube, VK Видео и ivi';

/**
 * Несколько наборов своих ответов разом: на каждый вопрос отвечает первый, кто ответил не
 * `undefined` (так наборы площадок и написаны: чужую площадку они пропускают).
 */
export function combine(...sets: CinemaOverrides[]): CinemaOverrides {
  const endpoints = new Set(sets.flatMap((set) => Object.keys(set)));
  return Object.fromEntries(
    [...endpoints].map((endpoint) => [
      endpoint,
      async (call: CinemaCall) => {
        for (const set of sets) {
          const found = await set[endpoint]?.(call);
          if (found !== undefined) return found;
        }
        return undefined;
      },
    ]),
  );
}

const DEFAULTS: Record<string, CinemaHandler> = {
  catalog: () => fixture('catalog'),
  link: ({ body }) => {
    const url = String(body?.url ?? '').trim();
    for (const [form, answer] of LINKS) {
      const found = form.exec(url);
      if (found) return answer(found);
    }
    return { item: null, reason: UNKNOWN_LINK };
  },
  providers: () => PROVIDERS_ANSWER,
  search: ({ params }) => {
    const query = (params.get('query') ?? '').trim().toLowerCase();
    if (params.get('cursor')) return { ...END, channels: [], categories: [] };
    if (params.get('provider') === 'twitch')
      return query ? { ...END, channels: [], categories: [] } : fixture('twitch-search');
    if (query.length < 2) return fixture('youtube-search-empty');
    return fixture(SEARCHES[query] ?? SEARCHES['big buck bunny']!);
  },
  channel: ({ params }) => {
    const cursor = params.get('cursor') ?? '';
    const tab = params.get('tab') ?? 'videos';
    const name = `${params.get('provider')}-channel-${tab}${cursor ? `-${cursor}` : ''}`;
    // Вкладки у канала нет или лента кончилась — служба отвечает так же.
    return exists(name) ? fixture(name) : { channel: null, ...END };
  },
  playlist: ({ params }) => {
    const page = fixture<Json>('youtube-playlist');
    return params.get('cursor') ? { playlist: page.playlist, ...END } : page;
  },
  categories: ({ params }) =>
    params.get('cursor') || params.get('query') ? END : fixture('twitch-categories'),
  category: ({ params }) => {
    const page = fixture<Json>('twitch-category');
    return params.get('cursor') ? { category: page.category, ...END } : page;
  },
  details: ({ params }) => {
    const provider = params.get('provider') ?? '';
    const id = params.get('id') ?? '';
    const name = DETAILS[`${provider}:${params.get('kind') ?? 'video'}`];
    if (!name) return reply(404, { detail: 'Для такой страницы записи нет' });
    const recorded = fixture<Json>(name);
    return recorded.id === id ? recorded : { ...wear(recorded, id, provider), id };
  },
  resolve: ({ body }) => {
    const provider = String(body?.provider ?? 'youtube');
    const contentId = String(body?.contentId ?? '');
    const live = body?.kind === 'channel';
    const recorded = fixture<Json>('youtube-resolve');
    const known = recorded.contentId === contentId && provider === recorded.provider;
    const face = known ? undefined : card(provider, contentId);
    return {
      ...recorded,
      provider,
      contentId,
      ...(known ? {} : { title: face?.title ?? contentId, author: face?.author ?? '' }),
      live,
      duration: live ? null : recorded.duration,
      captions: live ? [] : recorded.captions,
      expiresAt: Date.now() + SIGNATURE_MS,
    };
  },
};

async function answer(route: Route, endpoint: string, overrides: CinemaOverrides, calls: CinemaCall[]) {
  const request = route.request();
  let sent: Json | null = null;
  try {
    sent = (request.postDataJSON() as Json | null) ?? null;
  } catch {
    sent = null;
  }
  const call: CinemaCall = {
    endpoint,
    method: request.method(),
    params: new URL(request.url()).searchParams,
    body: sent,
  };
  calls.push(call);
  let result = await overrides[endpoint]?.(call);
  if (result === undefined) {
    const fallback = DEFAULTS[endpoint];
    result = fallback ? await fallback(call) : reply(404, { detail: 'Not Found' });
  }
  const { status, body } = result instanceof CinemaReply ? result : { status: 200, body: result };
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/**
 * Отвечать за службу кинозала на этой странице.
 *
 * Перехватываются `…/services/rooms/{комната}/cinema/…` и `…/services/catalog` (без каталога
 * панель интеграций не предлагает кинозал), а ещё `/fixtures/…` — серая обложка, HLS и
 * субтитры (SRT — переведёнными в WebVTT, как у службы). Возвращает журнал запросов: по нему
 * видно, что каталог действительно спросил.
 */
export async function routeCinema(page: Page, overrides: CinemaOverrides = {}) {
  const calls: CinemaCall[] = [];
  await page.route(
    (url) => CINEMA.test(url.pathname),
    (route) => {
      const endpoint = new URL(route.request().url()).pathname.match(CINEMA)![1]!;
      return answer(route, endpoint, overrides, calls);
    },
  );
  await page.route(
    (url) => url.pathname === '/api/v1/services/catalog',
    (route) => answer(route, 'catalog', overrides, calls),
  );
  await page.route(
    (url) => url.pathname.startsWith('/fixtures/'),
    async (route) => {
      const wanted = new URL(route.request().url()).pathname.slice('/fixtures/'.length);
      const file = path.resolve(FIXTURES, decodeURIComponent(wanted));
      if (!file.startsWith(FIXTURES) || !existsSync(file)) return route.fulfill({ status: 404 });
      // Субтитры площадки приходят SRT, а `<track>` читает только WebVTT: служба переводит их
      // маршрутом `subtitles`, здесь — перехват (`webvtt`).
      if (path.extname(file) === '.srt')
        return route.fulfill({
          contentType: 'text/vtt; charset=utf-8',
          body: webvtt(readFileSync(file, 'utf8')),
        });
      await route.fulfill({
        path: file,
        contentType: TYPES[path.extname(file)] ?? 'application/octet-stream',
      });
    },
  );
  return { calls };
}

/** Новая встреча от первого лица; ждёт, пока медиа не выйдет в эфир. */
export async function startMeeting(page: Page, name = 'Майс') {
  await page.goto('/');
  await page.getByRole('button', { name: /Новая встреча/ }).click();
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Начать встречу' }).click();
  await expect(page.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 20000 });
}

/** Ссылка приглашения из окна «Пригласить участников». */
export async function inviteLink(page: Page) {
  await page.getByRole('button', { name: 'Пригласить участников', exact: true }).click();
  const link = await page.getByRole('textbox', { name: 'Ссылка приглашения' }).inputValue();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  return link;
}

/** Войти во встречу по приглашению вторым человеком. */
export async function joinMeeting(page: Page, invitation: string, name = 'Алекс') {
  await page.goto(invitation);
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: 'Войти во встречу' }).click();
  await expect(page.getByText('В эфире', { exact: true })).toBeVisible({ timeout: 20000 });
}

/**
 * Интеграции → «Кинозал» → площадка; возвращает открытый каталог.
 *
 * На узком экране интеграций в нижней панели нет — они в меню «Настройки и действия».
 * Группы ищутся по заголовку, а не по тексту: у занятой группы в подписи стоит чужое имя.
 */
export async function openCinema(page: Page, providerName: string): Promise<Locator> {
  const panel = page.locator('.services-panel');
  if (!(await panel.isVisible())) {
    const integrations = page.getByRole('button', { name: 'Интеграции', exact: true });
    if (await integrations.isVisible()) await integrations.click();
    else {
      await page.getByRole('button', { name: 'Настройки и действия' }).click();
      await page.getByRole('menuitem', { name: 'Интеграции' }).click();
    }
  }
  // Группа «Кинозал» могла остаться открытой с прошлого раза — тогда её плитки уже на месте.
  if (!(await panel.locator('.cinema-group').isVisible()))
    await panel
      .locator('.service-group')
      .filter({ has: page.getByText('Кинозал', { exact: true }) })
      .click();
  await panel
    .locator('.service-tile')
    .filter({ has: page.getByText(providerName, { exact: true }) })
    .click();
  const browse = page.locator('.cinema-browser');
  await expect(browse).toBeVisible();
  return browse;
}
