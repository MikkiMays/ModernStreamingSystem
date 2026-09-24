import { useEffect, useEffectEvent, type Dispatch, type SetStateAction } from 'react';
import type { Meeting } from '../../core/meeting';
import { ROOMY } from '../breakpoints';
import { useMediaQuery, useStore } from '../primitives';
import type { Panel } from '../Sidebar';

/**
 * Панель встречи уступает кинозалу сцену — но только в ответ на то, что человек сделал сам.
 *
 * ЗАЧЕМ УСТУПАТЬ. Уже 960 px панель лежит поверх сцены: на телефоне листом во весь низ, на
 * планшете полосой справа. Кинозал открывается на сцене — то есть под ней. Каталог открывался
 * и оставался невидимым под листом («Совместный просмотр недоступен», 19.09), фильм включался —
 * и треть кадра с качеством и полным экраном оставалась под полосой. Поэтому, когда человек
 * сам открыл каталог или сам включил фильм, панель закрывается — любая: интеграции, чат,
 * люди. Он только что попросил сцену, и под листом ему кино не найти. С 960 px кинозал
 * отодвигается от полосы сам (`ui/cinema/cinema.css`), и закрывать нечего.
 *
 * ЧЕГО НЕ ДЕЛАТЬ. Закрываться от того, чего человек не делал: фильм включил другой участник,
 * кончилась чужая демонстрация, окно стало уже. Поэтому оба правила срабатывают по смене того,
 * что сделал сам человек, а ширину экрана читают в момент этой смены: от смены ширины они не
 * срабатывают вовсе. Недописанное в чате при закрытии не пропадает — его хранит встреча
 * (`Meeting.draft`), а не панель.
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
    if (!roomy) setPanel(null);
  });
  useEffect(() => {
    if (browsing) step();
  }, [browsing]);
  useEffect(() => {
    if (mine) step();
  }, [mine]);
}
