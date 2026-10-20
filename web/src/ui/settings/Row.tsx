import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { anchorDomId, rowDomId, rowText, type RowId } from './sections';

/**
 * Куда окно настроек просит прийти: подраздел (его группа раскрывается) и строка (её коротко
 * подсвечивают). `nonce` растёт на каждый переход — повторный выбор того же места тоже работает.
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
 * Группа строк под заголовком — сворачивается, как у FACEIT. У подраздела-якоря группа знает свой
 * якорь: переход к нему из списка слева раскрывает её, даже если её свернули.
 */
export function SettingGroup({
  title,
  anchor,
  id,
  note,
  defaultOpen = true,
  collapsible = true,
  children,
}: {
  title: string;
  anchor?: string;
  /** Группа сама — строка карты (её находит поиск): «Звуки игр», «Клавиши кинозала и игр». */
  id?: RowId;
  /** Одна строка под заголовком — для всей группы сразу. */
  note?: ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const target = useContext(SettingsTargetContext);
  /*
    Переход сюда раскрывает группу ещё при отрисовке, а не эффектом после неё: окно меряет место
    строки в своём эффекте раскладки, и строка в скрытом теле дала бы ноль — прокрутка ушла бы в
    начало раздела, а подсветка мигнула бы за краем.
  */
  const [seen, setSeen] = useState(0);
  const aimed = (!!anchor && target.anchor === anchor) || (!!id && target.row === id);
  if (aimed && target.nonce && target.nonce !== seen) {
    setSeen(target.nonce);
    if (!open) setOpen(true);
  }
  const base = useId();
  const shown = open || !collapsible;
  return (
    <section
      className="setting-group"
      id={anchor ? anchorDomId(anchor) : id ? rowDomId(id) : undefined}
      aria-labelledby={`${base}-title`}
      data-open={shown || undefined}
    >
      <h3 className="setting-group__head">
        {collapsible ? (
          <button
            type="button"
            className="setting-group__toggle"
            aria-expanded={shown}
            aria-controls={`${base}-body`}
            onClick={() => setOpen(!open)}
          >
            <span id={`${base}-title`}>{title}</span>
            <ChevronDown size={18} aria-hidden="true" className="setting-group__chevron" />
          </button>
        ) : (
          <span id={`${base}-title`}>{title}</span>
        )}
      </h3>
      <div className="setting-group__body" id={`${base}-body`} hidden={!shown}>
        {note && <p className="setting-group__note">{note}</p>}
        {children}
      </div>
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
