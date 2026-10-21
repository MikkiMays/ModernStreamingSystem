import { Store } from './store';

/**
 * Знакомство с Cord (E13, T34): что из подсказок этот человек уже видел.
 *
 * Учётных записей нет, поэтому «пройдено» помнит устройство — своим ключом рядом с настройками
 * (`cord:onboarding:v1`), как ширина панелей. Три подсказки:
 *
 * - `tour` — первый запуск: 3–5 шагов у настоящих кнопок главной (`TOUR`), можно пропустить;
 * - `meeting` — первый вход во встречу: одна подсказка у микрофона, камеры и экрана;
 * - `integrations` — первое открытие интеграций: одна подсказка, что они общие для всех.
 *
 * Показанное и закрытое — любым способом: «Готово», «Пропустить», Esc или нажатие мимо — больше не
 * показывается. Вернуть всё — «Пройти знакомство» в «О программе» (`replayOnboarding`).
 */
export type Hint = 'tour' | 'meeting' | 'integrations';
export type Seen = Record<Hint, boolean>;

export const ONBOARDING_KEY = 'cord:onboarding:v1';

const NOTHING: Seen = { tour: false, meeting: false, integrations: false };

export function readOnboarding(): Seen {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ONBOARDING_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return { ...NOTHING };
    const record = saved as Partial<Record<Hint, unknown>>;
    return {
      tour: record.tour === true,
      meeting: record.meeting === true,
      integrations: record.integrations === true,
    };
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
 * в закрытом меню и не свёрнута вместе с пультом.
 */
export function anchorFor(name: TourStep | 'dock', root: ParentNode = document): HTMLElement | null {
  const element = root.querySelector<HTMLElement>(`[data-tour="${name}"]`);
  if (!element) return null;
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 ? element : null;
}
