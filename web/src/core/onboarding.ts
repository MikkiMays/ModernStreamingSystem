import { Store } from './store';

/**
 * Знакомство с Cord (E13, T34): видел ли этот человек тур по главной.
 *
 * Учётных записей нет, поэтому «пройдено» помнит устройство — своим ключом рядом с настройками
 * (`cord:onboarding:v1`), как ширина панелей. Подсказка одна — `tour`: первый запуск, 3–5 шагов у
 * настоящих кнопок главной (`TOUR`), можно пропустить. Во встрече подсказок нет (R27): «Вы во встрече»
 * у пульта и «Интеграции — для всех» вылезали поверх сцены и на телефоне закрывали полэкрана; старые
 * записи с этими полями просто читаются без них.
 *
 * Показанное и закрытое — любым способом: «Готово», «Пропустить», Esc или нажатие мимо — больше не
 * показывается. Вернуть — «Пройти знакомство» в «О программе» (`replayOnboarding`).
 */
export type Hint = 'tour';
export type Seen = Record<Hint, boolean>;

export const ONBOARDING_KEY = 'cord:onboarding:v1';

const NOTHING: Seen = { tour: false };

export function readOnboarding(): Seen {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ONBOARDING_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return { ...NOTHING };
    return { tour: (saved as Partial<Record<Hint, unknown>>).tour === true };
  } catch {
    return { ...NOTHING };
  }
}

export const onboarding = new Store<Seen>(readOnboarding());

function save(next: Seen) {
  onboarding.set(next);
  try {
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify(next));
  } catch {
    /* Приватный режим: помним до закрытия вкладки. */
  }
}

export function markSeen(hint: Hint) {
  if (onboarding.get()[hint]) return;
  save({ ...onboarding.get(), [hint]: true });
}

/** «Пройти знакомство»: все подсказки — снова, с первого шага. */
export function replayOnboarding() {
  save({ ...NOTHING });
}

/**
 * Шаги знакомства на главной — по порядку. Каждый стоит у своей кнопки (`data-tour="<шаг>"`);
 * кнопки, которой сейчас нет на экране, шаг пропускает. `menu` — бургер на телефоне: там избранное,
 * настройки и помощь спрятаны в меню, и три шага сворачиваются в один.
 */
export const TOUR = ['create', 'join', 'favorites', 'settings', 'help', 'menu'] as const;
export type TourStep = (typeof TOUR)[number];

/** Пять — потолок: дольше знакомство превращается в урок. */
const MAX_STEPS = 5;

/** Шаги, которые можно показать сейчас; меньше двух главных — знакомить не с чем. */
export function tourSteps(visible: (step: TourStep) => boolean): TourStep[] {
  if (!visible('create') && !visible('join')) return [];
  return TOUR.filter(visible).slice(0, MAX_STEPS);
}

/**
 * Кнопка подсказки на экране (`data-tour="<имя>"`): есть в документе и занимает место — не спрятана
 * в закрытом меню.
 */
export function anchorFor(name: TourStep, root: ParentNode = document): HTMLElement | null {
  const element = root.querySelector<HTMLElement>(`[data-tour="${name}"]`);
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 ? element : null;
}
