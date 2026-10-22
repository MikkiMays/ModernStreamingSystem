import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { anchorDomId, rowDomId, rowText, type RowId } from './sections';

/**
 * Куда окно настроек просит прийти: подраздел и строка (её коротко подсвечивают). `nonce` растёт на каждый переход — повторный выбор того же места тоже работает.
 */
export interface SettingsTarget {
  anchor?: string;
  row?: RowId;
  nonce: number;
}
export const SettingsTargetContext = createContext<SettingsTarget>({ nonce: 0 });

/** Подпись и пояснение строки — для `aria-labelledby` / `aria-describedby` её управления. */
export interface RowA11y {
  'aria-labelledby': string;
  'aria-describedby'?: string;
}

/**
 * Строка настроек по образцу FACEIT: подпись и короткое пояснение слева, действие справа, тонкая
 * линия между строками. На узком окне действие, которому тесно (ползунок, выбор из списка),
 * уходит под подпись во всю ширину — `stack`.
 */
export function SettingRow({
  id,
  label,
  hint,
  stack = false,
  disabled = false,
  below,
  children,
}: {
  id: RowId;
  /** Своя подпись вместо записанной в `ROWS` — там, где строка стоит вне окна настроек. */
  label?: string;
  /** Своё пояснение вместо записанного в `ROWS`; `null` — без пояснения. */
  hint?: ReactNode;
  stack?: boolean;
  disabled?: boolean;
  /** Во всю ширину под строкой: предупреждение, превью камеры, запись пробы. */
  below?: ReactNode;
  children?: ReactNode | ((a11y: RowA11y) => ReactNode);
}) {
  const { t } = useTranslation();
  const spec = rowText(t, id);
  const base = useId();
  const labelId = `${base}-label`;
  const hintId = `${base}-hint`;
  const shownHint = hint === undefined ? spec.hint : hint;
  const a11y: RowA11y = {
    'aria-labelledby': labelId,
    ...(shownHint ? { 'aria-describedby': hintId } : {}),
  };
  const target = useContext(SettingsTargetContext);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (target.row !== id || !target.nonce) return;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(timer);
  }, [target.row, target.nonce, id]);
  return (
    <div
      className="setting-row"
      id={rowDomId(id)}
      data-stack={stack || undefined}
      data-disabled={disabled || undefined}
      data-flash={flash || undefined}
    >
      <div className="setting-row__text">
        <span className="setting-row__label" id={labelId}>
          {label ?? spec.label}
        </span>
        {shownHint && (
          <span className="setting-row__hint" id={hintId}>
            {shownHint}
          </span>
        )}
      </div>
      {children !== undefined && (
        <div className="setting-row__control">
          {typeof children === 'function' ? children(a11y) : children}
        </div>
      )}
      {below && <div className="setting-row__below">{below}</div>}
    </div>
  );
}

/**
 * Группа строк под заголовком (R16): просто заголовок и разделитель, как у Discord, — без
 * «скрыть / раскрыть». Что из группы будет карточкой (Телемост, разделы «Звук», «Видео»), а что —
 * группой с волоском между группами (длинные списки «Горячих клавиш» и «Windows»), решает раскладка
 * раздела (`data-layout` тела раздела), а не сама группа.
 *
 * У подраздела-якоря группа знает свой якорь — к нему ведёт список слева и по нему считается
 * подсветка; группа-строка карты (`id`) находится поиском.
 */
export function SettingGroup({
  title,
  anchor,
  id,
  note,
  aside,
  children,
}: {
  title: string;
  anchor?: string;
  /** Группа сама — строка карты (её находит поиск): «Звуки игр», «Клавиши кинозала и игр». */
  id?: RowId;
  /** Одна строка под заголовком — для всей группы сразу. */
  note?: ReactNode;
  /** Справа от заголовка: индикатор уровня у «Микрофона». */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const base = useId();
  return (
    <section
      className="setting-group"
      id={anchor ? anchorDomId(anchor) : id ? rowDomId(id) : undefined}
      aria-labelledby={`${base}-title`}
    >
      <div className="setting-group__top">
        <h3 className="setting-group__head" id={`${base}-title`}>
          {title}
        </h3>
        {aside}
      </div>
      {note && <p className="setting-group__note">{note}</p>}
      {children}
    </section>
  );
}

/** Значение справа от подписи: «Подключено», «Ctrl + Shift + M», «45 %». */
export function SettingValue({ children, tone }: { children: ReactNode; tone?: 'success' | 'muted' }) {
  return (
    <span className="setting-value" data-tone={tone}>
      {children}
    </span>
  );
}

/** Полоса уровня: голос в микрофон и всё, что меряется от нуля до ста. */
export function LevelBar({ level, label }: { level: number; label: string }) {
  const value = Math.max(0, Math.min(100, Math.round(level)));
  return (
    <div
      className="setting-level"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
    >
      <span className="setting-level__fill" style={{ transform: `scaleX(${value / 100})` }} />
    </div>
  );
}
