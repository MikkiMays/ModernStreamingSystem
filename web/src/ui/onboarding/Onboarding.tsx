import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { anchorFor, markSeen, onboarding, tourSteps, type TourStep } from '../../core/onboarding';
import { Coachmark, type CoachmarkProps } from '../kit';
import { useStore } from '../primitives';

/**
 * С какой стороны от кнопки встаёт подсказка шага. Избранное, настройки и помощь — в левой панели,
 * поэтому подсказка справа от них, над пустым полем; вход — над полем кода, чтобы не закрыть
 * «Новую встречу» под ним.
 */
const PLACE: Record<TourStep, Pick<CoachmarkProps, 'side' | 'align'>> = {
  create: { side: 'bottom', align: 'center' },
  join: { side: 'top', align: 'center' },
  favorites: { side: 'right', align: 'start' },
  settings: { side: 'right', align: 'center' },
  help: { side: 'right', align: 'center' },
  menu: { side: 'bottom', align: 'start' },
};

/** Через сколько после появления экрана начинать: дать ему встать и не мигать при загрузке. */
const SETTLE_MS = 500;

/**
 * Знакомство на главной (E13, T34): 3–5 шагов у настоящих кнопок — «Новая встреча», вход по коду,
 * избранное, настройки, помощь. На телефоне последние три спрятаны в меню, и шаг один — у бургера.
 * Можно пропустить; пройденное или пропущенное больше не показывается, пока человек сам не нажмёт
 * «Пройти знакомство» в «О программе».
 *
 * `paused` — поверх главной открыто окно (настройки): знакомство ждёт, пока его закроют.
 */
export function HomeTour({ paused = false }: { paused?: boolean }) {
  const { t } = useTranslation();
  const seen = useStore(onboarding);
  const active = !seen.tour && !paused;
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [index, setIndex] = useState(0);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  // Шаги — по тому, какие кнопки сейчас на экране; поворот телефона или ширина окна их меняют.
  useEffect(() => {
    if (!active) return;
    const resolve = () => setSteps(tourSteps((step) => !!anchorFor(step)));
    const timer = setTimeout(resolve, SETTLE_MS);
    window.addEventListener('resize', resolve);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', resolve);
    };
  }, [active]);

  const position = Math.min(index, steps.length - 1);
  const step = position >= 0 ? steps[position] : undefined;
  useEffect(() => {
    setAnchor(active && step ? anchorFor(step) : null);
  }, [active, step, steps]);

  if (!active || !step || !anchor) return null;
  const last = position === steps.length - 1;
  const finish = () => {
    markSeen('tour');
    setIndex(0);
    setSteps([]);
  };
  return (
    <Coachmark
      key={step}
      anchor={anchor}
      {...PLACE[step]}
      progress={t(($) => $.onboarding.progress, { step: position + 1, total: steps.length })}
      title={t(($) => $.onboarding.tour[step].title)}
      action={last ? t(($) => $.onboarding.done) : t(($) => $.onboarding.next)}
      onAction={() => (last ? finish() : setIndex(position + 1))}
      secondary={last ? undefined : t(($) => $.onboarding.skip)}
      onSecondary={finish}
      onDismiss={finish}
    >
      {t(($) => $.onboarding.tour[step].text)}
    </Coachmark>
  );
}
