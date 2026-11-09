import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button, Dialog, Field, Input } from '../ui/kit';
import { text } from '../i18n/admin/ru';
import { failureText } from './api';

/*
  Детали пульта (R220): один набор на все разделы — панель, ряд величин, плашка состояния, строка отказа, пустое
  состояние, скелет и опасное подтверждение. Цвет здесь никогда не единственный носитель смысла: у состояния есть
  слово, у отказа — значок и текст.
*/

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent';

/** Ряд величин: число крупно, подпись под ним; между величинами — волосок, а не карточка. */
export function Stats({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={['admin-stats', className].filter(Boolean).join(' ')}>{children}</dl>;
}

export function Stat({
  value,
  label,
  tone,
  compact,
  note,
}: {
  value: ReactNode;
  label: ReactNode;
  tone?: Exclude<Tone, 'neutral' | 'accent'>;
  /** Значение — слова, а не число: мельче и с переносом. */
  compact?: boolean;
  /** Мелкая строка под подписью: «из 812», «за 30 дней». */
  note?: ReactNode;
}) {
  return (
    <div className="admin-stat" data-tone={tone} data-compact={compact || undefined}>
      <dt className="admin-stat__label">{label}</dt>
      <dd className="admin-stat__value">{value}</dd>
      {note && <dd className="admin-stat__note">{note}</dd>}
    </div>
  );
}

/** Панель раздела: заголовок, пояснение, действия справа, тело. `flush` — тело без отступов (таблица во всю ширину). */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  flush,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
  id?: string;
}) {
  return (
    <section
      id={id}
      className={['admin-panel', className].filter(Boolean).join(' ')}
      data-flush={flush || undefined}
    >
      <header className="admin-panel__head">
        <div className="admin-panel__titles">
          <h2>{title}</h2>
          {description && <p className="admin-panel__description">{description}</p>}
        </div>
        {actions && <div className="admin-panel__actions">{actions}</div>}
      </header>
      <div className="admin-panel__body">{children}</div>
    </section>
  );
}

/** Плашка состояния: точка и слово — «выполняется», «сбой», «на связи». */
export function Pill({
  tone = 'neutral',
  children,
  title,
  dot = false,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
  dot?: boolean;
}) {
  return (
    <span className="admin-pill" data-tone={tone} title={title}>
      {dot && <span className="admin-pill__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Точка состояния рядом с именем; слово для диктора — `label`. */
export function Dot({ state, label }: { state: 'ok' | 'bad' | 'warn' | 'unknown'; label?: string }) {
  return (
    <>
      <span className="admin-dot" data-state={state} aria-hidden="true" />
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}

/** Красная строка отказа с кнопкой «Повторить»; данные прошлого обновления остаются на экране с пометкой времени. */
export function ErrorLine({
  error,
  onRetry,
  updatedAt,
}: {
  error: unknown;
  onRetry?: () => void;
  /** Когда данные на экране были получены (мс) — «данные на 14:05». */
  updatedAt?: number;
}) {
  if (!error) return null;
  return (
    <div className="admin-error" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>
        {failureText(error)}
        {updatedAt ? (
          <span className="admin-error__stale">
            {' '}
            · {text.app.staleAt} {when(updatedAt / 1000)}
          </span>
        ) : null}
      </span>
      {onRetry && (
        <Button variant="quiet" size="sm" icon={<RefreshCw size={16} />} onClick={onRetry}>
          {text.app.retry}
        </Button>
      )}
    </div>
  );
}

/** Пусто — одна фраза и, если уместно, одно действие. */
export function Empty({
  children,
  action,
  icon,
}: {
  children: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="admin-empty">
      {icon && (
        <span className="admin-empty__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="admin-skeleton" aria-busy="true" aria-label={text.app.loading} role="status">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} />
      ))}
    </div>
  );
}

/**
 * Опасное подтверждение: заголовок-глагол, последствия, при `confirmWord` — поле, куда надо напечатать имя;
 * красная кнопка «вживую» и, если операция это умеет, кнопка «Сухой прогон».
 */
export function Confirm({
  open,
  onOpenChange,
  title,
  warning,
  children,
  confirmWord,
  confirmLabel,
  dryRun,
  danger = true,
  busy,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  warning?: ReactNode;
  children?: ReactNode;
  confirmWord?: string;
  confirmLabel: string;
  /** Кнопка «Сухой прогон»: та же операция без выполнения. */
  dryRun?: () => void;
  danger?: boolean;
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);
  const ready = !confirmWord || typed.trim() === confirmWord;
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="md"
      closeLabel={text.app.close}
      footer={
        <>
          <Button variant="quiet" onClick={() => onOpenChange(false)}>
            {text.app.cancel}
          </Button>
          {dryRun && (
            <Button variant="secondary" onClick={dryRun} disabled={busy}>
              {text.app.dryRun}
            </Button>
          )}
          <Button
            variant={danger ? 'danger' : 'primary'}
            icon={danger ? <AlertTriangle size={16} /> : undefined}
            onClick={onConfirm}
            disabled={!ready}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="admin-confirm">
        {warning && (
          <p className="admin-warning">
            <AlertTriangle size={16} aria-hidden="true" />
            <span>{warning}</span>
          </p>
        )}
        {children}
        {confirmWord && (
          <Field label={`${text.nodes.confirmName}: ${confirmWord}`}>
            <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
          </Field>
        )}
        <ErrorLine error={error} />
      </div>
    </Dialog>
  );
}

/** Русские формы числа: `plural(3, ['встреча', 'встречи', 'встреч'])` → «встречи». */
export function plural(n: number, forms: readonly [string, string, string]): string {
  const rule = new Intl.PluralRules('ru-RU').select(Math.abs(n));
  return rule === 'one' ? forms[0] : rule === 'few' ? forms[1] : forms[2];
}

export function when(ts: number | null | undefined, withDate = false): string {
  if (!ts) return '—';
  const date = new Date(ts * 1000);
  return withDate
    ? date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function iso(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)} %`;
}

export function gigabytes(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '—'
    : `${(value / 1e9).toFixed(value > 1e10 ? 0 : 1)} ${text.units.gb}`;
}

export function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours
    ? `${hours} ${text.units.hours} ${minutes % 60} ${text.units.minutes}`
    : `${minutes} ${text.units.minutes}`;
}
