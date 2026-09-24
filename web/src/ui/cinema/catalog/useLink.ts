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
 * (`cancel`), вставить новую ссылку или уйти из кинозала — тогда ответ просто забывается.
 */
export function useLink(meeting: Meeting, api: CinemaApi) {
  const client = useQueryClient();
  /** Какую ссылку спрашивают прямо сейчас; пусто — никакую. */
  const [checking, setChecking] = useState('');
  const [problem, setProblem] = useState<unknown>(null);
  /** Номер последнего вопроса: ответ на любой прежний уже никуда не ведёт. */
  const latest = useRef(0);

  const remember = (url: string) => {
    const recent = meeting.media.preferences.get().cinemaLinks;
    meeting.media.saveSettings({ cinemaLinks: rememberLink(recent, url) });
  };

  /** Набранное сменилось — ответа на прежнюю ссылку больше не ждут. */
  const cancel = () => {
    latest.current += 1;
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
    const from = meeting.cinema.get();
    const options = {
      queryKey: linkQuery(url),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.link(url, signal),
      staleTime: LINK_TTL,
      retry: false,
    };
    setChecking(url);
    setProblem(null);
    let answer: CinemaLinkAnswer | null = null;
    let failure: unknown = null;
    // В `try` — только сам вопрос: условное выражение внутри `try` React Compiler не берёт.
    try {
      answer = await client.fetchQuery(options);
    } catch (error) {
      failure = error;
    }
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

  return { follow, cancel, checking, problem };
}
