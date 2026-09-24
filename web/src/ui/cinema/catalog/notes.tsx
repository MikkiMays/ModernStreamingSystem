import { LoaderCircle } from 'lucide-react';

/*
  Три строки, которыми каталог отвечает вместо ленты: отказ, ожидание и пустота. У каждой
  страницы каталога они одни и те же — отличается только текст пустоты.
*/

/** Отказ площадки или сети — тем текстом, которым его сказала служба. */
export function Failure({ problem }: { problem: unknown }) {
  return (
    <p className="form-error" role="alert">
      {(problem as Error).message}
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
 * поиска в это время нет: ссылка — не слова для поиска.
 */
export function Following({ checking, problem }: { checking: boolean; problem: unknown }) {
  if (problem) return <Failure problem={problem} />;
  if (!checking) return null;
  return (
    <p className="cinema-waiting" role="status">
      <LoaderCircle size={22} /> Открываем ссылку…
    </p>
  );
}
