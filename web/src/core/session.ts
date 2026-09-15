import { ApiError, publicApi, request, useSession, SESSION_KEY } from '../api/client';
import type { Capabilities } from '../api/types';
import { Store } from './store';
import { currentServerUrl, findServer, saveServer } from './servers';
import { notifyDesktop } from './desktop';

/**
 * The handshake with the server itself, before any room exists.
 *
 * It answers one question — may this person use this server at all — and it happens once per
 * visit. The token lives in `sessionStorage`: closing the tab ends the connection, which is
 * what "connected while the application is open" means in a browser. A meeting already under
 * way is never interrupted by it; see {@link renew}.
 */
export interface ServerSession {
  token: string;
  /** Epoch seconds. */
  expiresAt: number;
  name: string;
  passwordRequired: boolean;
}

const KEY = SESSION_KEY;
/** Renew this long before the token actually lapses, so nothing expires mid-request. */
const MARGIN_SECONDS = 300;

export const session = new Store<ServerSession | null>(read());

function read(): ServerSession | null {
  let stored: Partial<ServerSession> | null = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Partial<ServerSession> | null;
  } catch {
    /* Treat anything unreadable as "not connected". */
  }
  if (
    !stored ||
    typeof stored.token !== 'string' ||
    typeof stored.expiresAt !== 'number' ||
    stored.expiresAt <= Date.now() / 1000
  )
    return null;
  return {
    token: stored.token,
    expiresAt: stored.expiresAt,
    name: typeof stored.name === 'string' ? stored.name : '',
    passwordRequired: stored.passwordRequired === true,
  };
}

function store(value: ServerSession | null) {
  try {
    if (value) sessionStorage.setItem(KEY, JSON.stringify(value));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* Keep the connection for this page load only. */
  }
  useSession(value?.token);
  session.set(value);
}

export function sessionToken(): string | undefined {
  return session.get()?.token;
}

export function connected(): boolean {
  return !!session.get();
}

export function disconnect() {
  store(null);
}

/** What the server says about itself before anyone has authenticated. */
export function serverInfo(): Promise<Capabilities> {
  return publicApi.capabilities();
}

/** The handshake itself. Whether its result is kept is the caller's decision. */
function handshake(password: string): Promise<ServerSession> {
  return request<ServerSession>('/session', { method: 'POST', body: JSON.stringify({ password }) });
}
export async function connect(password = ''): Promise<ServerSession> {
  const issued = await handshake(password);
  store(issued);
  return issued;
}

let handed: ((session: ServerSession) => void) | null = null;
/**
 * The Windows client holds the password itself, protected by Windows, and never gives it to
 * the page. So the page does not renew there — it says the session lapsed and takes whatever
 * the host hands back.
 */
export function adopt(issued: ServerSession) {
  store(issued);
  handed?.(issued);
}
function askTheHost(): Promise<boolean> {
  notifyDesktop('session.expired');
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      handed = null;
      resolve(false);
    }, 5000);
    handed = () => {
      clearTimeout(timer);
      handed = null;
      resolve(true);
    };
  });
}

let renewal: Promise<boolean> | null = null;
/**
 * Quietly gets a new token when the old one lapses.
 *
 * This is what keeps a long meeting safe: the answer to an expired token is never "back to the
 * connect screen", it is another handshake with the password this device already holds. Only
 * when there is nothing to hand over does the interface have to ask, and even then the meeting
 * itself stays open — see {@link import('../App')}.
 */
export function renew(): Promise<boolean> {
  renewal ??= (async () => {
    const saved = findServer(currentServerUrl());
    try {
      if (window.chrome?.webview) return await askTheHost();
      const info = await serverInfo();
      if (info.passwordRequired && !saved?.password) {
        // Nothing to offer: stop claiming to be connected so the connect screen can ask. A
        // meeting already open is not interrupted — it simply never shows that screen.
        store(null);
        return false;
      }
      await connect(info.passwordRequired ? saved!.password : '');
      return true;
    } catch {
      return false;
    } finally {
      // One attempt per burst of failing requests, not one per request. Cleared as soon as
      // this attempt settles: everyone already waiting gets its answer, and the next failure
      // after it is a new situation that deserves a new try.
      renewal = null;
    }
  })();
  return renewal;
}

/** Remembers a working password so the next launch can connect without asking. */
export function rememberConnection(password: string, autoConnect: boolean) {
  const current = findServer(currentServerUrl());
  saveServer({
    url: currentServerUrl(),
    name: current?.name ?? '',
    password,
    autoConnect,
  });
}

/**
 * A connection attempt reduced to what the connect screen has to show: it worked, or it did
 * not and here is the reason in one sentence. "Не удалось выполнить запрос" tells nobody
 * whether to fix the password or the address.
 */
export interface Attempt {
  ok: boolean;
  detail: string;
  name?: string;
}
/**
 * Connects and stays connected. This is what «Подключиться» does.
 */
export async function openConnection(password = ''): Promise<Attempt> {
  return attempt(password, true);
}
/**
 * Shakes hands and lets go. «Проверить подключение» answers a question; it must not quietly
 * move the person to a different screen as a side effect of answering it.
 */
export async function checkConnection(password = ''): Promise<Attempt> {
  return attempt(password, false);
}
async function attempt(password: string, keep: boolean): Promise<Attempt> {
  try {
    const issued = keep ? await connect(password) : await handshake(password);
    return { ok: true, detail: '', name: issued.name };
  } catch (error) {
    return { ok: false, detail: describeFailure(error) };
  }
}
export function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'SERVER_PASSWORD_INVALID')
      return 'Сервер не принял пароль. Проверьте его у того, кто дал адрес.';
    if (error.code === 'SERVER_PASSWORD_REQUIRED') return 'Этот сервер закрыт паролем — введите его.';
    if (error.status === 429) return 'Слишком много попыток подряд. Подождите минуту и повторите.';
    if (error.status >= 500) return `Сервер ответил ошибкой ${error.status}. Похоже, он ещё запускается.`;
    if (error.status === 404) return 'По этому адресу отвечает не Cord: нужного API там нет.';
    return error.message;
  }
  if (error instanceof DOMException && error.name === 'TimeoutError')
    return 'Сервер не ответил за восемь секунд. Проверьте адрес и соединение.';
  return 'Не удалось связаться с сервером. Проверьте адрес, сертификат и соединение.';
}

export function expiringSoon(): boolean {
  const current = session.get();
  return !!current && current.expiresAt - MARGIN_SECONDS <= Date.now() / 1000;
}
