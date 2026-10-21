/**
 * Невидимая проверка «не бот» на создании встречи, входе по коду (E11-B, решение 15 архитектуры) и
 * обращении в поддержку (E13).
 *
 * Сервер выдаёт задачу proof-of-work (`GET /api/v1/proof?for=create|code`), браузер решает её в
 * фоновом потоке и прикладывает ответ заголовком `X-Cord-Proof`. Человек этого не видит: решение
 * начинается, как только открыта форма (`prepareProof`), и к нажатию «Войти» обычно уже готово.
 * Ответ одноразовый — после каждого входа задача берётся новая.
 *
 * Запрос задачи приходит снаружи (`fetchChallenge`): модуль не знает про `api/client.ts`, иначе
 * они импортировали бы друг друга.
 */
import { solveChallenge, type Challenge } from './proof-solve';

export type ProofAction = 'create' | 'code' | 'support';
/** Задача от сервера; `undefined` — проверка на сервере выключена (`204`). */
export type FetchChallenge = () => Promise<Challenge | undefined>;

const pending = new Map<ProofAction, Promise<string | null>>();

/** Начать решать заранее. Повторный вызов до `takeProof` ничего не меняет. */
export function prepareProof(action: ProofAction, fetchChallenge: FetchChallenge): void {
  if (!pending.has(action))
    pending.set(
      action,
      obtain(fetchChallenge).catch(() => null),
    );
}

/**
 * Ответ для заголовка `X-Cord-Proof` — подготовленный заранее или решённый сейчас — либо `null`,
 * если проверка выключена или задачу получить не вышло: тогда решит сервер, пускать ли без неё.
 */
export async function takeProof(action: ProofAction, fetchChallenge: FetchChallenge): Promise<string | null> {
  const ready = pending.get(action) ?? obtain(fetchChallenge).catch(() => null);
  pending.delete(action);
  return ready;
}

async function obtain(fetchChallenge: FetchChallenge): Promise<string | null> {
  const challenge = await fetchChallenge();
  return challenge ? solve(challenge) : null;
}

function solve(challenge: Challenge): Promise<string | null> {
  if (typeof Worker === 'undefined') return Promise.resolve(solveChallenge(challenge));
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./proof.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(solveChallenge(challenge));
      return;
    }
    const done = (value: string | null) => {
      worker.terminate();
      resolve(value);
    };
    worker.onmessage = (event: MessageEvent<string | null>) => done(event.data);
    // Поток не поднялся (старый WebView, запрет политики) — решаем здесь же: задержка лучше отказа.
    worker.onerror = () => done(solveChallenge(challenge));
    worker.postMessage(challenge);
  });
}
