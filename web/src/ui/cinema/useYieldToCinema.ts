import { useEffect, useEffectEvent, type Dispatch, type SetStateAction } from 'react';
import type { Meeting } from '../../core/meeting';
import { ROOMY } from '../breakpoints';
import { useMediaQuery, useStore } from '../primitives';
import type { Panel } from '../Sidebar';

/**
 * Панель интеграций уступает кинозалу место — но только в ответ на то, что человек сделал сам.
 *
 * ЗАЧЕМ УСТУПАТЬ. Кинозал открывают из панели интеграций, а на экране уже 960 px панель лежит
 * поверх сцены: на телефоне листом во весь низ, на планшете полосой справа. Каталог открывался
 * и оставался под листом, фильм включался — и треть кадра с качеством и полным экраном
 * оставалась под полосой. Поэтому, когда человек открыл каталог или сам включил фильм, панель
 * интеграций закрывается: своё дело она сделала. С 960 px кинозал просто отодвигается от
 * полосы (`room-layout.css`), и закрывать нечего.
 *
 * ЧЕГО НЕ ДЕЛАТЬ. Закрываться от того, чего человек не делал: фильм включил другой участник,
 * кончилась чужая демонстрация, окно стало уже. И закрывать не свою панель: чат с недописанным
 * сообщением при закрытии теряет его вместе с разметкой (`Sidebar.tsx`, `draft`), а люди и чат
 * кинозалом не открываются — значит, и уступать им нечего. Поэтому оба правила срабатывают по
 * смене того, что сделал сам человек, а ширину экрана читают в момент этой смены — от смены
 * ширины они не срабатывают вовсе.
 */
export function useYieldToCinema(meeting: Meeting, setPanel: Dispatch<SetStateAction<Panel | null>>) {
  const roomy = useMediaQuery(ROOMY);
  /** Каталог открывает только сам человек: из панели, с пульта плеера или вкладкой площадки. */
  const browsing = useStore(meeting.cinema);
  const watch = useStore(meeting.snapshot).watch;
  /**
   * Фильм, который включил я. Ключ — площадка и ролик, а не `revision`: её меняют и пауза, и
   * перемотка, а уступать место стоит только новому фильму. Следующий свой фильм — новый ключ,
   * и панель, открытая между ними, уступает снова.
   */
  const mine =
    watch && watch.openedBy === meeting.admission.participantId ? `${watch.provider}:${watch.contentId}` : '';
  const step = useEffectEvent(() => {
    if (!roomy) setPanel((current) => (current === 'services' ? null : current));
  });
  useEffect(() => {
    if (browsing) step();
  }, [browsing]);
  useEffect(() => {
    if (mine) step();
  }, [mine]);
}
