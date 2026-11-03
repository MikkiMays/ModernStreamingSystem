import type { Participant } from '../api/types';
import type { StageView } from './stage-view';

/**
 * Показ экрана как в Google Meet (R183).
 *
 * Владелец 03.11.2026: «сразу на всю сцену при открытии шаринга… аналогично как в гугл мите, а не как
 * сейчас». Было как в Discord: на плитке показывающего «Смотреть стрим», экран открывался только своим
 * нажатием, а сам показывающий своего экрана не видел. Теперь показ — отдельная плитка («отдельный
 * участник»), и новый показ сам встаёт крупно у каждого, включая показывающего.
 *
 * Здесь только правила, без интерфейса: какие показы идут и какой из них открыть этому зрителю. Что уже
 * открывали, помнит встреча (`Meeting`), раскладку рисует `ui/Stage.tsx`.
 */
export interface Presentation {
  participantId: string;
  screenId: string;
  name: string;
  /** Свой показ: на своей сцене — своя дорожка, без сети. */
  own: boolean;
  /**
   * Показ можно смотреть. Чужой — когда отправитель открыл его зрителям (`screenStarted`, T48: кадр
   * целевого качества уже закодирован); до этого у всех «Готовится показ…». Свой — как только дорожка
   * опубликована: свой кадр есть сразу, ждать сеть не нужно.
   */
  ready: boolean;
}

type Person = Pick<
  Participant,
  'id' | 'name' | 'screen' | 'screenId' | 'screenStarted' | 'service' | 'status'
>;

/**
 * Идущие показы — в порядке участников снимка. Слот показа взят (`screen`, `screenId`) — показ уже есть,
 * хотя бы как «Готовится показ…». Служебные участники экран не показывают; ожидающий у двери — тоже.
 */
export function presentations(people: readonly Person[], self: string, ownLive: boolean): Presentation[] {
  return people
    .filter((person) => !person.service && person.status !== 'WAITING' && person.screen && !!person.screenId)
    .map((person) => {
      const own = person.id === self;
      return {
        participantId: person.id,
        screenId: person.screenId!,
        name: person.name,
        own,
        ready: own ? ownLive : !!person.screenStarted,
      };
    });
}

/**
 * Какой показ открыть крупно самому и какие показы теперь считаются замеченными.
 *
 * Правила:
 * 1. Каждый показ открывается сам **один раз** — когда его можно смотреть (`ready`). Закрыл («Открепить»,
 *    закрепил камеру, открыл каталог) — показ остаётся плиткой и сам не вернётся, пока не начнётся новый:
 *    `screenId` новый у каждого показа, переопубликация (качество, кодек, переподключение) его не меняет.
 * 2. Интеграцию на сцене (стол, доска, кинозал — вид `integration`, R121) показ не отбирает: у столов ход по
 *    часам, а фильм идёт для всех. Такой показ не замечается — он откроется, как только сцена у зрителя
 *    освободится (ушёл к участникам или интеграция кончилась); до того о нём говорит чип над сценой.
 * 3. Несколько новых показов разом (вход во встречу, где показывают двое) — чужой важнее своего, а из
 *    чужих — первый по снимку.
 */
export function presentationToOpen(
  list: readonly Presentation[],
  seen: ReadonlySet<string>,
  view: StageView,
): { open: Presentation | null; seen: string[] } {
  if (view === 'integration') return { open: null, seen: [] };
  const fresh = list.filter((show) => show.ready && !seen.has(show.screenId));
  return {
    open: fresh.find((show) => !show.own) ?? fresh[0] ?? null,
    seen: fresh.map((show) => show.screenId),
  };
}
