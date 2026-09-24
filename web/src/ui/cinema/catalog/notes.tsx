import { LoaderCircle } from 'lucide-react';

/*
  Три строки, которыми каталог отвечает вместо ленты: отказ, ожидание и пустота. У каждой
  страницы каталога они одни и те же — отличается только текст пустоты.
*/

/** Так `fetch` говорит об обрыве сети: Chrome, Firefox и Safari — каждый своими словами. */
const OFFLINE = /failed to fetch|networkerror|load failed|network request failed/i;

/**
 * Отказ — словами для человека. Отказ службы приходит уже её словами. Обрыв сети — это `TypeError`
 * самого `fetch`, и его текст английский и браузерный («Failed to fetch»): его человек видеть не
 * должен. Срок запроса, вышедший у браузера, — `TimeoutError`, и он тоже не английский.
 */
export function problemText(problem: unknown): string {
  if (problem instanceof TypeError && OFFLINE.test(problem.message))
    return 'Нет связи с сервером — попробуйте ещё раз';
  if (problem instanceof DOMException && problem.name === 'TimeoutError')
    return 'Сервер не ответил вовремя — попробуйте ещё раз';
  return (problem as Error | null)?.message || 'Не удалось выполнить запрос';
}

/** Отказ площадки или сети — словами службы или своими, если это обрыв сети (`problemText`). */
export function Failure({ problem }: { problem: unknown }) {
  return (
    <p className="form-error" role="alert">
      {problemText(problem)}
    </p>
  );
}

/** Страница уже открыта, а содержимое ещё едет от площадки. */
export function Loading() {
  return (
    <p className="cinema-waiting" role="status">
      <LoaderCircle size={22} /> Спрашиваем площадку…
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
}: {
  checking: boolean;
  problem: unknown;
  /** Набрана ссылка, о которой ещё не спросили. */
  waiting?: boolean;
}) {
  if (problem) return <Failure problem={problem} />;
  if (waiting)
    return (
      <p className="muted" role="status">
        Нажмите Enter — и кинозал откроет эту ссылку.
      </p>
    );
  if (!checking) return null;
  return (
    <p className="cinema-waiting" role="status">
      <LoaderCircle size={22} /> Открываем ссылку…
    </p>
  );
}
