import { useEffect } from 'react';
import { CloudOff, GlobeLock, LoaderCircle, RotateCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { knownProvider } from '../../../core/cinema/link';
import { countryName, LATE, MUSIC_LATE, providerName, refusedBy } from '../../../core/cinema';
import { musicSourceName, type MusicSource } from '../../../core/services';
import type { Translate } from '../../../i18n';
import { classify, noteFailure, type Place } from '../../../core/failure';
import { Button } from '../../kit';

/*
  Три строки, которыми каталог отвечает вместо ленты: отказ, ожидание и пустота. У каждой
  страницы каталога они одни и те же — отличается только текст пустоты.
*/

/**
 * Отказ — словами для человека. Отказ службы приходит уже её словами. Обрыв сети — это `TypeError`
 * самого `fetch`, и его текст английский и браузерный («Failed to fetch»): его человек видеть не
 * должен. Срок запроса, вышедший у браузера, — `TimeoutError`, и он тоже не английский. Площадку,
 * до которой сервер не достаёт или которая не ответила за срок службы (R112), служба называет
 * кодом и именем (`refusedBy`) — и слова здесь свои, на языке человека. Так же — отказы поиска и
 * ссылок музыки (`MUSIC_UNREACHABLE`, `MUSIC_TIMEOUT`). Прочее — общая точка перевода
 * (`core/failure.ts`, R180): текст исключения, английское слово FastAPI или русская фраза службы на
 * чужом языке сюда не доходят. Функция чистая — её зовёт и отрисовка; учёт — `problemNoted`.
 */
export function problemText(t: Translate, problem: unknown, place: Place = 'cinema'): string {
  const refused = refusedBy(problem);
  const music = refusedBy(problem, 'music');
  const name =
    refused && knownProvider(refused)
      ? providerName(t, refused)
      : music
        ? musicSourceName(t, music as MusicSource)
        : null;
  if (name) {
    const code = (problem as { code: string }).code;
    return code === LATE || code === MUSIC_LATE
      ? t(($) => $.cinema.reach.late, { name })
      : t(($) => $.cinema.reach.unreachable, { name });
  }
  const { code, text } = classify(problem, place);
  if (code === 'offline') return t(($) => $.cinema.notes.offline);
  if (code === 'timeout') return t(($) => $.cinema.notes.timeout);
  return text || t(($) => $.failure.places[place]);
}

/** То же, что `problemText`, и в журнал и счётчик — для обработчиков, а не для отрисовки. */
export function problemNoted(t: Translate, problem: unknown, place: Place = 'cinema'): string {
  noteFailure(place, classify(problem, place).code, problem);
  return problemText(t, problem, place);
}

/**
 * Отказ площадки или сети — словами службы или своими, если это обрыв сети (`problemText`), и с
 * кнопкой «Повторить», если страница знает, что повторять: сам каталог второй раз не спрашивает ни
 * недоступную площадку, ни вышедший срок (`retryCatalog`) — это решает человек.
 */
export function Failure({ problem, onRetry }: { problem: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  // Учёт — один раз на отказ, а не на каждую отрисовку.
  useEffect(() => noteFailure('cinema', classify(problem, 'cinema').code, problem), [problem]);
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
 *
 * Тот же блок — у музыки (`ui/music/MusicPanel`): YouTube музыки ходит тем же yt-dlp и тем же
 * автоматом площадки, поэтому и недоступен с того же сервера одинаково. `name` — имя площадки на
 * языке человека: у кинозала — `providerName`, у музыки — `musicSourceName`.
 */
export function Unreachable({ name, onRetry }: { name: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="cinema-empty cinema-unreachable" role="status">
      <CloudOff size={40} />
      <b>{t(($) => $.cinema.reach.unreachable, { name })}</b>
      <small>{t(($) => $.cinema.reach.unreachableHint)}</small>
      <Button size="sm" icon={<RotateCw />} onClick={onRetry}>
        {t(($) => $.cinema.reach.retry)}
      </Button>
    </div>
  );
}

/**
 * Площадка работает только с серверов другой страны (`CINEMA_REGION`, R172: ivi — только из России) —
 * вместо всей витрины, сразу и без «Спрашиваем площадку…»: каталог здесь заведомо пуст, и звать в него
 * незачем. «Повторить» нет: страна сервера от нажатия не изменится. `country` — страна этого сервера
 * кодом (`DE`), пустая — служба её не назвала.
 */
export function Region({ name, country }: { name: string; country: string }) {
  const { t } = useTranslation();
  const place = countryName(t, country);
  return (
    <div className="cinema-empty cinema-unreachable cinema-region" role="status">
      <GlobeLock size={40} />
      <b>{t(($) => $.cinema.reach.region, { name })}</b>
      <small>
        {place
          ? t(($) => $.cinema.reach.regionHint, { country: place })
          : t(($) => $.cinema.reach.regionHintPlain)}
      </small>
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
      <LoaderCircle size={20} /> {t(($) => $.cinema.notes.asking)}
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
      <LoaderCircle size={20} /> {t(($) => $.cinema.notes.opening)}
    </p>
  );
}
