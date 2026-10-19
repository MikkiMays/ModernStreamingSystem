import { useState } from 'react';
import { TITLE_MAX } from '../../core/favorite-groups';

/**
 * Поле имени прямо в строке списка: переименовать группу или комнату «у себя», создать группу.
 * Enter — сохранить, Esc — отказаться; уход фокуса сохраняет, как в ChatGPT. Пустое имя у комнаты
 * значит «вернуть название встречи», у новой группы — передумать.
 */
export function InlineName({
  initial,
  label,
  placeholder,
  onCommit,
  onCancel,
  className,
}: {
  initial: string;
  label: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  const [done, setDone] = useState(false);
  const finish = (commit: boolean) => {
    if (done) return;
    setDone(true);
    if (commit && value.trim() !== initial.trim()) onCommit(value.trim());
    else onCancel();
  };
  return (
    <input
      className={className ? `home-inline-name ${className}` : 'home-inline-name'}
      aria-label={label}
      value={value}
      placeholder={placeholder}
      maxLength={TITLE_MAX}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}
