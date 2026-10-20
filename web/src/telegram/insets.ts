/**
 * Безопасные зоны Mini App → CSS-переменные `--tg-inset-*` (`telegram.css` сводит их с `env()`).
 *
 * В полноэкранном режиме Telegram (Bot API 8.0) сверху два слоя: зона устройства (`safeAreaInset`:
 * вырез, статус-бар) и зона самого Telegram (`contentSafeAreaInset`: плавающие «✕» и «⋯»). Шапка
 * встречи уходит ниже обоих — иначе кнопки Telegram лягут на название встречи. Снизу и по бокам
 * действует то же правило: пульт встаёт над жестовой полосой.
 */
export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const SIDES = ['top', 'bottom', 'left', 'right'] as const;

export function insetVariables(safe: Insets, content: Insets): Record<string, string> {
  return Object.fromEntries(
    SIDES.map((side) => {
      const value = Math.max(0, Math.round((safe[side] || 0) + (content[side] || 0)));
      return [`--tg-inset-${side}`, `${value}px`];
    }),
  );
}

export function applyInsets(vars: Record<string, string>, root: HTMLElement = document.documentElement) {
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}
