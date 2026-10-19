import { Field as BaseField } from '@base-ui/react/field';
import type { ComponentProps, ReactNode } from 'react';

type ControlProps = ComponentProps<typeof BaseField.Control>;

/**
 * Поле: подпись, элемент ввода, пояснение и ошибка — связаны для диктора через Base UI Field.
 * Внутрь кладётся `Input`, `Select`, `Textarea` или `Slider` из набора; подпись над полем,
 * пояснение серым под ним, ошибка — красным вместо пояснения.
 */
export interface FieldProps {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Подпись и поле в одну строку: для переключателей и ползунков в настройках. */
  inline?: boolean;
}

export function Field({ label, description, error, children, className, inline = false }: FieldProps) {
  const classes = ['ui-field', inline && 'ui-field--inline', error && 'ui-field--invalid', className]
    .filter(Boolean)
    .join(' ');
  return (
    <BaseField.Root className={classes} invalid={!!error}>
      <BaseField.Label className="ui-field__label">{label}</BaseField.Label>
      <div className="ui-field__control">{children}</div>
      {error ? (
        <BaseField.Error className="ui-field__error" match>
          {error}
        </BaseField.Error>
      ) : (
        description && <BaseField.Description className="ui-field__hint">{description}</BaseField.Description>
      )}
    </BaseField.Root>
  );
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <BaseField.Control
      className={className ? `ui-input ${className}` : 'ui-input'}
      {...(props as ControlProps)}
    />
  );
}

/* `Field.Control` типизирован как `<input>`; textarea и select подставляются через `render`,
   как велит Base UI, а их собственные атрибуты (`rows`, `multiple`) едут через приведение. */
export function Textarea({ className, rows = 3, ...props }: ComponentProps<'textarea'>) {
  return (
    <BaseField.Control
      render={<textarea rows={rows} />}
      className={className ? `ui-input ui-input--area ${className}` : 'ui-input ui-input--area'}
      {...(props as ControlProps)}
    />
  );
}

/** Нативный `<select>`: на телефоне открывает системный список, стрелка — из токенов. */
export function Select({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <BaseField.Control
      render={<select>{children}</select>}
      className={className ? `ui-input ui-select ${className}` : 'ui-input ui-select'}
      {...(props as ControlProps)}
    />
  );
}
