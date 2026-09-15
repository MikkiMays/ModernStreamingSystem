import { serverInfo } from './session';
import { currentServerUrl } from './servers';
import { Store } from './store';

/**
 * Whether a saved server is answering.
 *
 * The server that served this page can be asked properly: `/api/v1/capabilities` returns
 * something we can read. Any other origin cannot — the core refuses a foreign `Origin`, and a
 * browser will not hand us the body of a cross-origin response anyway.
 *
 * What a browser *can* tell, with `mode: 'no-cors'`, is whether anything answered at all: the
 * request settles when a server responded (even with a refusal) and rejects when nothing did,
 * or when its certificate was not accepted. That is a narrower fact than "this is a working
 * Cord", so the interface says «отвечает» rather than «подключено» for those.
 */
export type Health = 'unknown' | 'checking' | 'alive' | 'dead';

interface Answer {
  state: Health;
  at: number;
}
/** How long an answer is worth reusing. Long enough not to flicker, short enough to notice. */
const FRESH_MS = 30_000;
const answers = new Map<string, Answer>();
const pending = new Map<string, Promise<Health>>();

/**
 * What the dots read, as a store rather than a plain lookup.
 *
 * Reading a module-level map during render is invisible to React: with the compiler on, the
 * list of servers has not changed, so the markup is reused and a dot that has since turned red
 * keeps showing grey. Everything else in this client publishes external state the same way —
 * `useSyncExternalStore` through `useStore` — and this is why.
 */
export const health = new Store<Readonly<Record<string, Health>>>({});

function publish(url: string, state: Health) {
  answers.set(url, { state, at: Date.now() });
  health.set({ ...health.get(), [url]: state });
}

/**
 * Asks once, then reuses the answer for a while. Without that, every render that lists the
 * servers would start the probes again and the dots would fall back to grey — the one thing a
 * status light must never do while the status has not changed.
 */
export function checkHealth(url: string, refresh = false): Promise<Health> {
  const already = pending.get(url);
  if (already) return already;
  const remembered = answers.get(url);
  if (!refresh && remembered && remembered.state !== 'checking' && Date.now() - remembered.at < FRESH_MS)
    return Promise.resolve(remembered.state);
  const probe = measure(url)
    .catch((): Health => 'dead')
    .then((result) => {
      pending.delete(url);
      publish(url, result);
      return result;
    });
  pending.set(url, probe);
  publish(url, 'checking');
  return probe;
}

async function measure(url: string): Promise<Health> {
  if (url === currentServerUrl()) {
    await serverInfo();
    return 'alive';
  }
  // An opaque response carries no status, which is the whole point: we only need to know that
  // the address is answering, and that is exactly what not throwing tells us.
  await fetch(new URL('api/v1/ping', url).href, {
    mode: 'no-cors',
    cache: 'no-store',
    signal: AbortSignal.timeout(4000),
  });
  return 'alive';
}
