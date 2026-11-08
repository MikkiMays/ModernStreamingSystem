import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button, Dialog, Field, Input } from '../ui/kit';
import { text } from '../i18n/admin/ru';
import { failureText } from './api';

/** Плитка числа с подписью — как на «Активности». */
export function Tile({
  value,
  label,
  tone,
}: {
  value: ReactNode;
  label: ReactNode;
  tone?: 'warn' | 'bad' | 'ok';
}) {
  return (
    <div className="admin-tile" data-tone={tone}>
      <div className="admin-tile__value">{value}</div>
      <div className="admin-tile__label">{label}</div>
    </div>
  );
}

/** Панель раздела: заголовок, действия справа, тело. */
export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={['admin-panel', className].filter(Boolean).join(' ')}>
      <header className="admin-panel__head">
        <h2>{title}</h2>
        {actions && <div className="admin-panel__actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** Красная строка отказа с кнопкой «Повторить»; данные прошлого обновления остаются на экране. */
export function ErrorLine({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="admin-error" role="alert">
      <AlertTriangle size={16} aria-hidden="true" />
      <span>{failureText(error)}</span>
      {onRetry && (
        <Button variant="quiet" size="sm" icon={<RefreshCw size={16} />} onClick={onRetry}>
          {text.app.retry}
        </Button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="admin-empty">{children}</p>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="admin-skeleton" aria-busy="true" aria-label={text.app.loading}>
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
            onClick={onConfirm}
            disabled={!ready}
            loading={busy}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
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
    </Dialog>
  );
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
