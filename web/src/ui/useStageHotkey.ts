import { useEffect, useRef } from 'react';
import { isTyping, matchesHotkey } from '../core/hotkeys';
import type { Meeting } from '../core/meeting';
import { useStore } from './primitives';
import { backToStage, leaveToPeople, STAGE_KEY } from './stage-context';
import { useStageView } from './useStageView';

/** Фокус нигде: на самой странице, а не на каком-то её элементе. */
function onPage(target: EventTarget | null): boolean {
  return (
    target === null ||
    target === window ||
    target === document ||
    target === document.body ||
    target === document.documentElement
  );
}

/**
 * Клавиша G (R121): из интеграции — к участникам и обратно.
 *
 * Буква без модификаторов, как клавиши плеера: сочетания с Ctrl, Alt и Meta принадлежат браузеру и системе,
 * а Shift-буквы занимает оверлей. G не занята ни плеером (пробел, K, M, F, стрелки), ни покером (F, C, R,
 * A), ни настройками по умолчанию. Слушает окно, но берёт клавишу, только когда фокус на сцене или нигде:
 * в чате и панели буква печатается или листает своё, в диалоге — его. Сочетание микрофона или оверлея,
 * назначенное на ту же G, остаётся их. Буква — по месту на клавиатуре (`code`): в русской раскладке это «п».
 */
export function useStageHotkey(meeting: Meeting) {
  const { occupant, view } = useStageView(meeting);
  const preferences = useStore(meeting.media.preferences);
  const latest = useRef({ view, preferences });
  useEffect(() => {
    latest.current = { view, preferences };
  });
  const busy = !!occupant;
  useEffect(() => {
    if (!busy) return;
    const listen = (event: KeyboardEvent) => {
      if (event.code !== STAGE_KEY || event.repeat || event.defaultPrevented) return;
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const target = event.target;
      if (isTyping(target) || document.querySelector('[role="dialog"]')) return;
      if (!onPage(target) && !(target instanceof Element && target.closest('.stage-wrap'))) return;
      const now = latest.current;
      if (
        matchesHotkey(event, now.preferences.micHotkey) ||
        matchesHotkey(event, now.preferences.overlayHotkey)
      )
        return;
      event.preventDefault();
      if (now.view === 'people') backToStage(meeting);
      else leaveToPeople(meeting);
    };
    window.addEventListener('keydown', listen);
    return () => window.removeEventListener('keydown', listen);
  }, [busy, meeting]);
}
