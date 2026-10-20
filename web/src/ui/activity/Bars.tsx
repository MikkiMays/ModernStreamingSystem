/**
 * Столбцы одной величины — для «Активности» (скилл `dataviz`): встречи по дням, длительность,
 * интеграции.
 *
 * Серия одна, поэтому легенды нет — её называет заголовок; цвет один — акцент, величину несёт
 * длина. Столбцы тонкие, с зазором 2 px и скруглённым концом данных; ось — тихая линия основания.
 * Подписи выборочные: у самого большого значения число видно всегда, у остальных — при наведении
 * и при фокусе с клавиатуры (подсказка), а для чтения экраном у каждого столбца своя фраза.
 */
export type BarItem = { key: string; label: string; value: number; tip: string };

export function Bars({
  title,
  items,
  horizontal = false,
}: {
  title: string;
  items: BarItem[];
  horizontal?: boolean;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  const top = items.reduce<BarItem | null>(
    (best, item) => (!best || item.value > best.value ? item : best),
    null,
  );
  return (
    <figure className={`activity-bars ${horizontal ? 'activity-bars--horizontal' : ''}`}>
      <figcaption>{title}</figcaption>
      <ul>
        {items.map((item) => (
          <li key={item.key} tabIndex={0} aria-label={`${item.label}: ${item.tip}`} data-tip={item.tip}>
            <span className="activity-bars__track">
              <span
                className="activity-bars__bar"
                style={
                  horizontal
                    ? { width: `${(item.value / max) * 100}%` }
                    : { height: `${(item.value / max) * 100}%` }
                }
              />
              {item === top && item.value > 0 && <span className="activity-bars__value">{item.value}</span>}
            </span>
            <span className="activity-bars__label" aria-hidden="true">
              {item.label}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
