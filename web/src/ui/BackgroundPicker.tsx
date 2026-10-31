import { Ban, Check, ImagePlus, Sparkles } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  allowed,
  backgroundSupport,
  BUILTIN_BACKGROUNDS,
  customBackgroundUrl,
  GRADIENTS,
  saveCustomBackground,
  type BackgroundChoice,
  type BackgroundSupport,
  type BuiltinBackground,
} from '../media/background-effect';
import { MenuRadioGroup, MenuRadioItem, MenuSubmenu } from './kit';
import './background-picker.css';

const same = (a: BackgroundChoice, b: BackgroundChoice) => JSON.stringify(a) === JSON.stringify(b);

/** Что умеет устройство — один раз на страницу. */
let supported: Promise<BackgroundSupport> | null = null;
function useSupport(): BackgroundSupport | null {
  const [support, setSupport] = useState<BackgroundSupport | null>(null);
  useEffect(() => {
    let alive = true;
    supported ??= backgroundSupport();
    void supported.then((value) => alive && setSupport(value));
    return () => {
      alive = false;
    };
  }, []);
  return support;
}

/**
 * Выбор фона в видео (R153) — плитками, как в Телемосте: «Без фона», два размытия, шесть встроенных
 * фонов и своё фото. Нельзя на этом устройстве (iPhone, Telegram, слабый телефон) — строки нет вовсе;
 * на телефоне с Android — только размытие.
 */
export function BackgroundPicker({
  value,
  onChange,
}: {
  value: BackgroundChoice;
  onChange: (choice: BackgroundChoice) => void;
}) {
  const { t } = useTranslation();
  const support = useSupport();
  const file = useRef<HTMLInputElement>(null);
  const id = useId();
  const [custom, setCustom] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void customBackgroundUrl().then(setCustom);
  }, []);
  if (!support || support === 'none') return null;
  const options: {
    choice: BackgroundChoice;
    label: string;
    tile: 'none' | 'blur' | BuiltinBackground | 'custom';
  }[] = [
    { choice: { kind: 'none' }, label: t(($) => $.background.none), tile: 'none' },
    { choice: { kind: 'blur', strength: 'light' }, label: t(($) => $.background.blurLight), tile: 'blur' },
    { choice: { kind: 'blur', strength: 'strong' }, label: t(($) => $.background.blurStrong), tile: 'blur' },
    ...(support === 'full'
      ? BUILTIN_BACKGROUNDS.map((name) => ({
          choice: { kind: 'image', id: name } as BackgroundChoice,
          label: t(($) => $.background.builtin[name]),
          tile: name,
        }))
      : []),
  ];
  return (
    <div className="background-picker">
      <div className="background-picker__tiles" role="radiogroup" aria-label={t(($) => $.background.title)}>
        {options.map((option) => {
          const checked = same(option.choice, value);
          return (
            <button
              key={option.label}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={option.label}
              title={option.label}
              className="background-picker__tile"
              data-tile={option.tile}
              data-strong={
                option.choice.kind === 'blur' && option.choice.strength === 'strong' ? true : undefined
              }
              style={
                option.choice.kind === 'image' && option.choice.id !== 'custom'
                  ? { backgroundImage: `linear-gradient(135deg, ${GRADIENTS[option.choice.id].join(', ')})` }
                  : undefined
              }
              onClick={() => onChange(option.choice)}
            >
              {option.tile === 'none' && <Ban size={16} aria-hidden="true" />}
              {option.tile === 'blur' && <Sparkles size={16} aria-hidden="true" />}
              {checked && <Check size={12} className="background-picker__check" aria-hidden="true" />}
            </button>
          );
        })}
        {support === 'full' && (
          <>
            <button
              type="button"
              role="radio"
              aria-checked={value.kind === 'image' && value.id === 'custom'}
              aria-label={custom ? t(($) => $.background.custom) : t(($) => $.background.upload)}
              title={custom ? t(($) => $.background.custom) : t(($) => $.background.upload)}
              className="background-picker__tile"
              data-tile="custom"
              style={custom ? { backgroundImage: `url(${custom})` } : undefined}
              onClick={() => (custom ? onChange({ kind: 'image', id: 'custom' }) : file.current?.click())}
            >
              {!custom && <ImagePlus size={16} aria-hidden="true" />}
              {value.kind === 'image' && value.id === 'custom' && (
                <Check size={12} className="background-picker__check" aria-hidden="true" />
              )}
            </button>
            {custom && (
              <button
                type="button"
                className="background-picker__replace"
                onClick={() => file.current?.click()}
              >
                {t(($) => $.background.replace)}
              </button>
            )}
            <input
              ref={file}
              id={id}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={async (event) => {
                const picked = event.target.files?.[0];
                event.target.value = '';
                if (!picked) return;
                setError('');
                try {
                  setCustom(await saveCustomBackground(picked));
                  onChange({ kind: 'image', id: 'custom' });
                } catch {
                  setError(t(($) => $.background.uploadFailed));
                }
              }}
            />
          </>
        )}
      </div>
      {!allowed(value, support) && (
        <p className="background-picker__note">{t(($) => $.background.notHere)}</p>
      )}
      {error && (
        <p className="background-picker__note" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** «Фон» в меню камеры во встрече: те же варианты, кроме своего фото (оно — в настройках). */
export function BackgroundSubmenu({
  value,
  onChange,
}: {
  value: BackgroundChoice;
  onChange: (choice: BackgroundChoice) => void;
}) {
  const { t } = useTranslation();
  const support = useSupport();
  if (!support || support === 'none') return null;
  const choices: [string, BackgroundChoice][] = [
    [t(($) => $.background.none), { kind: 'none' }],
    [t(($) => $.background.blurLight), { kind: 'blur', strength: 'light' }],
    [t(($) => $.background.blurStrong), { kind: 'blur', strength: 'strong' }],
    ...(support === 'full'
      ? BUILTIN_BACKGROUNDS.map(
          (name) =>
            [t(($) => $.background.builtin[name]), { kind: 'image', id: name }] as [string, BackgroundChoice],
        )
      : []),
  ];
  const current = choices.find(([, choice]) => same(choice, value))?.[0] ?? choices[0]![0];
  return (
    <MenuSubmenu icon={<Sparkles />} label={t(($) => $.background.title)}>
      <MenuRadioGroup
        value={current}
        onValueChange={(label: string) => {
          const found = choices.find(([name]) => name === label);
          if (found) onChange(found[1]);
        }}
      >
        {choices.map(([label]) => (
          <MenuRadioItem key={label} value={label} closeOnClick className="ui-menu__item">
            <span className="ui-menu__icon" aria-hidden="true">
              {label === current && <Check />}
            </span>
            <span className="ui-menu__label">{label}</span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </MenuSubmenu>
  );
}
