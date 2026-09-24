import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { CinemaApi, CinemaLinkAnswer } from '../../../core/cinema';
import { atOf, knownProvider, rememberLink } from '../../../core/cinema/link';
import type { Meeting } from '../../../core/meeting';

/**
 * Ответ службы о ссылке помнится несколько минут: чья ссылка, от времени не меняется, а предел у
 * комнаты — двадцать ссылок в минуту, и та же ссылка, вставленная снова, его тратить не должна.
 */
export const LINK_TTL = 5 * 60 * 1000;

/** Ключ ответа о ссылке: один на все сцены — «По ссылке» показывает то, что спросила другая сцена. */
export const linkQuery = (url: string) => ['cinema', 'link', url] as const;

/**
 * Вставленная ссылка — куда она ведёт, одинаково из любой сцены.
 *
 * Служба отвечает, чья это ссылка (`POST …/cinema/link`): своя площадка — сцена открывается сразу на
 * нужной странице (`Meeting.openCinema(площадка, at)`), своей нет — ссылка уходит в сцену «По
 * ссылке», и та показывает, что нашлось или почему не открыть. Ссылка, которая куда-то привела,
 * встаёт первой в недавние (`cinemaLinks` профиля).
 *
 * Ответ на прежнюю ссылку никуда не ведёт: пока служба отвечала, человек мог набрать другое
 * (`cancel`), вставить новую ссылку или уйти из кинозала — тогда ответ просто забывается, а вопрос,
 * который ещё в пути, обрывается: ждать его незачем. Спрашивают службу только о ссылке, которую
 * вставили, открыли Enter или кнопкой, — не о каждой паузе в наборе: разбор чужой страницы дорог, и у
 * комнаты их десять в минуту. Новая ссылка комнаты сменяет прежнюю и на сервере (`providers/link.py`).
 */
export function useLink(meeting: Meeting, api: CinemaApi) {
  const client = useQueryClient();
  /** Какую ссылку спрашивают прямо сейчас; пусто — никакую. */
  const [checking, setChecking] = useState('');
  /** О какой ссылке спросили последней; пусто — ни о какой с тех пор, как набранное сменилось. */
  const [asked, setAsked] = useState('');
  const [problem, setProblem] = useState<unknown>(null);
  /** Номер последнего вопроса: ответ на любой прежний уже никуда не ведёт. */
  const latest = useRef(0);
  /** Вопрос, который ещё в пути: его обрывает следующая ссылка или новый набор. */
  const inFlight = useRef('');

  const remember = (url: string) => {
    const recent = meeting.media.preferences.get().cinemaLinks;
    meeting.media.saveSettings({ cinemaLinks: rememberLink(recent, url) });
  };

  /** Оборвать вопрос в пути: его ответ уже никуда не ведёт, а запрос не должен висеть до ответа. */
  const abort = () => {
    const url = inFlight.current;
    inFlight.current = '';
    if (url) void client.cancelQueries({ queryKey: linkQuery(url), exact: true });
  };

  /** Набранное сменилось — ответа на прежнюю ссылку больше не ждут. */
  const cancel = () => {
    latest.current += 1;
    abort();
    setAsked('');
    setChecking('');
    setProblem(null);
  };

  /**
   * Спросить службу и пойти, куда ведёт ссылка. `true` — ссылка открыла сцену своей площадки: поле,
   * в которое её вставили, можно очистить.
   */
  const follow = async (url: string): Promise<boolean> => {
    latest.current += 1;
    const turn = latest.current;
    // Та же ссылка ещё раз (Enter после вставки) — к тому же вопросу, а другая обрывает прежний.
    if (inFlight.current !== url) abort();
    inFlight.current = url;
    const from = meeting.cinema.get();
    const options = {
      queryKey: linkQuery(url),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.link(url, signal),
      staleTime: LINK_TTL,
      retry: false,
    };
    setChecking(url);
    setAsked(url);
    setProblem(null);
    let answer: CinemaLinkAnswer | null = null;
    let failure: unknown = null;
    // В `try` — только сам вопрос: условное выражение внутри `try` React Compiler не берёт.
    try {
      answer = await client.fetchQuery(options);
    } catch (error) {
      failure = error;
    }
    if (inFlight.current === url) inFlight.current = '';
    if (turn !== latest.current || meeting.cinema.get() !== from) return false;
    setChecking('');
    if (!answer) {
      setProblem(failure);
      return false;
    }
    const route = answer.route;
    if (route && knownProvider(route.provider)) {
      remember(url);
      meeting.openCinema(route.provider, atOf(route));
      return true;
    }
    if (!answer.route && answer.item) remember(url);
    // Своей площадки нет — ссылку показывает «По ссылке»; если она и так открыта, идти некуда.
    if (from !== 'link') meeting.openCinema('link', { page: 'link', url });
    return false;
  };

  return { follow, cancel, checking, asked, problem };
}
