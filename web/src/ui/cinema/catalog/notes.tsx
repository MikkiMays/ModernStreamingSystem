import { CloudOff, LoaderCircle, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { knownProvider } from '../../../core/cinema/link';
import { LATE, providerName, refusedBy, type ProviderId } from '../../../core/cinema';
import type { Translate } from '../../../i18n';
import { Button } from '../../kit';

/*
  Три строки, которыми каталог отвечает вместо ленты: отказ, ожидание и пустота. У каждой
  страницы каталога они одни и те же — отличается только текст пустоты.
*/

/** Так `fetch` говорит об обрыве сети: Chrome, Firefox и Safari — каждый своими словами. */
const OFFLINE = /failed to fetch|networkerror|load failed|network request failed/i;

/**
 * Отказ — словами для человека. Отказ службы приходит уже её словами. Обрыв сети — это `TypeError`
 * самого `fetch`, и его текст английский и браузерный («Failed to fetch»): его человек видеть не
 * должен. Срок запроса, вышедший у браузера, — `TimeoutError`, и он тоже не английский. Площадку,
 * до которой сервер не достаёт или которая не ответила за срок службы (R112), служба называет
 * кодом и именем (`refusedBy`) — и слова здесь свои, на языке человека.
 */
export function problemText(t: Translate, problem: unknown): string {
  const refused = refusedBy(problem);
  if (refused && knownProvider(refused)) {
    const name = providerName(t, refused);
    return (problem as { code: string }).code === LATE
      ? t(($) => $.cinema.reach.late, { name })
      : t(($) => $.cinema.reach.unreachable, { name });
  }
  if (problem instanceof TypeError && OFFLINE.test(problem.message)) return t(($) => $.cinema.notes.offline);
  if (problem instanceof DOMException && problem.name === 'TimeoutError')
    return t(($) => $.cinema.notes.timeout);
  return (problem as Error | null)?.message || t(($) => $.cinema.notes.failed);
}

/**
 * Отказ площадки или сети — словами службы или своими, если это обрыв сети (`problemText`), и с
 * кнопкой «Повторить», если страница знает, что повторять: сам каталог второй раз не спрашивает ни
 * недоступную площадку, ни вышедший срок (`retryCatalog`) — это решает человек.
 */
export function Failure({ problem, onRetry }: { problem: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="cinema-failure">
      <p className="form-error" role="alert">
        {problemText(t, problem)}
      </p>
      {onRetry && (
        <Button size="sm" icon={<RotateCw />} onClick={onRetry}>
          {t(($) => $.cinema.reach.retry)}
        </Button>
      )}
    </div>
  );
}

/**
 * Площадка недоступна с этого сервера (`GET providers`: `code: CINEMA_UNREACHABLE`, R112) — вместо
 * витрины и подсказок, а не вместо самой площадки: вкладка остаётся, и человек видит, что с ней и
 * что делать. «Повторить» спрашивает службу снова: она сама проверит, вернулась ли площадка.
 */
export function Unreachable({ provider, onRetry }: { provider: ProviderId; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="cinema-empty cinema-unreachable" role="status">
      <CloudOff size={40} />
      <b>{t(($) => $.cinema.reach.unreachable, { name: providerName(t, provider) })}</b>
      <small>{t(($) => $.cinema.reach.unreachableHint)}</small>
      <Button size="sm" icon={<RotateCw />} onClick={onRetry}>
        {t(($) => $.cinema.reach.retry)}
      </Button>
    </div>
  );
}

/** «Повторить» у отказа запроса: спросить его заново. У запроса без `refetch` кнопки нет. */
export function retryOf(query: { refetch?: () => Promise<unknown> }): (() => void) | undefined {
  const again = query.refetch;
  return again ? () => void again() : undefined;
}

/** Страница уже открыта, а содержимое ещё едет от площадки. */
export function Loading() {
  const { t } = useTranslation();
  return (
    <p className="cinema-waiting" role="status">
      <LoaderCircle size={22} /> {t(($) => $.cinema.notes.asking)}
    </p>
  );
}

/** Пусто — и сказано, почему, словами этой страницы. */
export function Empty({ text }: { text: string }) {
  return <p className="muted">{text}</p>;
}

/**
 * В поиск вставили ссылку, и служба ещё говорит, куда она ведёт, — или не смогла сказать. Витрины и
 * поиска в это время нет: ссылка — не слова для поиска. Ссылку, набранную по букве, службу не
 * спрашивают, пока её не открыли Enter (`waiting`): каждая пауза в наборе была бы разбором чужой
 * страницы.
 */
export function Following({
  checking,
  problem,
  waiting,
  onRetry,
}: {
  checking: boolean;
  problem: unknown;
  /** Набрана ссылка, о которой ещё не спросили. */
  waiting?: boolean;
  /** Спросить о той же ссылке снова — у отказа есть кнопка «Повторить». */
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  if (problem) return <Failure problem={problem} onRetry={onRetry} />;
  if (waiting)
    return (
      <p className="muted" role="status">
        {t(($) => $.cinema.notes.pressEnter)}
      </p>
    );
  if (!checking) return null;
  return (
    <p className="cinema-waiting" role="status">
      <LoaderCircle size={22} /> {t(($) => $.cinema.notes.opening)}
    </p>
  );
}
