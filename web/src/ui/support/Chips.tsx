import { Checkbox } from '@base-ui/react/checkbox';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Check } from 'lucide-react';
import './chips.css';

/**
 * Чипы поддержки: тема обращения — одна из нескольких (`ChoiceChips`, радиогруппа), что не так во
 * встрече — сколько угодно (`ToggleChips`, флажки, R79). Ряд переносится, а не уезжает вбок, как
 * сегмент, поэтому семь тем и пять бед помещаются и на телефоне. Роли и клавиатура — Base UI:
 * у радиогруппы один стоп Tab и стрелки, у флажков — Tab по каждому и пробел.
 */
export interface ChipOption<T extends string> {
  value: T;
  label: string;
}

export function ChoiceChips<T extends string>({
  options,
  value,
  onValueChange,
  labelledBy,
}: {
  options: readonly ChipOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  /** Id видимой подписи группы — имя для диктора. */
  labelledBy: string;
}) {
  return (
    <RadioGroup<T>
      className="ui-chips"
      value={value}
      onValueChange={(next) => onValueChange(next)}
      aria-labelledby={labelledBy}
    >
      {options.map((option) => (
        <Radio.Root key={option.value} value={option.value} className="ui-chip">
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  );
}

export function ToggleChips<T extends string>({
  options,
  value,
  onValueChange,
  labelledBy,
}: {
  options: readonly ChipOption<T>[];
  value: readonly T[];
  onValueChange: (value: T[]) => void;
  labelledBy: string;
}) {
  return (
    <div className="ui-chips" role="group" aria-labelledby={labelledBy}>
      {options.map((option) => {
        const checked = value.includes(option.value);
        return (
          <Checkbox.Root
            key={option.value}
            className="ui-chip"
            checked={checked}
            onCheckedChange={(next) =>
              onValueChange(next ? [...value, option.value] : value.filter((item) => item !== option.value))
            }
          >
            <Checkbox.Indicator className="ui-chip__check" keepMounted>
              <Check aria-hidden="true" />
            </Checkbox.Indicator>
            {option.label}
          </Checkbox.Root>
        );
      })}
    </div>
  );
}
