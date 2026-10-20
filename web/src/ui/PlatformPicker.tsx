import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import type { PlatformArea } from '../core/preferences';
import { Badge, Button } from './kit';
import { useStore } from './primitives';

/**
 * Выбор площадки при входе — один и тот же у кинозала и музыки (T59).
 *
 * Владелец попросил, чтобы музыка открывалась так же, как кинозал: сначала площадка. Поэтому экран
 * выбора — один компонент на двоих, а не две похожие копии: «Назад к интеграциям», название группы
 * и строка «Выберите площадку», то, что идёт сейчас, плитки площадок и сноски под ними. Плитка —
 * знак на цвете площадки, имя и одна строка: что там есть или почему площадка недоступна (строкой,
 * а не подсказкой по наведению — палец её не покажет).
 *
 * Последний выбор помнит устройство (`lastPlatform` в настройках профиля): плитка отмечена, и фокус
 * при входе стоит на ней — вернуться туда же можно одним Enter. Порядок плиток при этом не меняется:
 * переставленный список пришлось бы каждый раз читать заново.
 */
export interface PlatformTile<Id extends string> {
  id: Id;
  name: string;
  /** Строка под именем: что на площадке — или почему она сейчас недоступна. */
  note: string;
  icon: LucideIcon;
  /** Цвет плитки: hex площадки или переменная темы. */
  color: string;
  /** Цвет знака, если белый на цвете площадки не читается. */
  ink?: string;
  disabled?: boolean;
}

/** Какую площадку выбирали здесь в прошлый раз — и как запомнить новый выбор. */
export function useLastPlatform(meeting: Meeting, area: PlatformArea) {
  const preferences = useStore(meeting.media.preferences);
  const last = preferences.lastPlatform?.[area] ?? null;
  const remember = (id: string) => {
    const saved = meeting.media.preferences.get().lastPlatform ?? {};
    if (saved[area] !== id) meeting.media.saveSettings({ lastPlatform: { ...saved, [area]: id } });
  };
  return { last, remember };
}

/** Цвет площадки для CSS: плитка и выбранная вкладка красятся одним и тем же. */
function paint(tile: PlatformTile<string>): CSSProperties {
  return { '--platform': tile.color, ...(tile.ink && { '--platform-ink': tile.ink }) } as CSSProperties;
}

export function PlatformPicker<Id extends string>({
  className,
  title,
  backLabel,
  onBack,
  label,
  tiles,
  last,
  onPick,
  now,
  focusOnEnter = true,
  children,
}: {
  /** Класс группы: по нему группу находят тесты в браузере (`cinema-group`). */
  className?: string;
  title: string;
  backLabel: string;
  onBack: () => void;
  /** Имя списка плиток для диктора: «Площадки кинозала». */
  label: string;
  tiles: readonly PlatformTile<Id>[];
  /** Выбор прошлого раза (`useLastPlatform`); незнакомое имя ничего не отмечает. */
  last: string | null;
  onPick: (id: Id) => void;
  /** Что идёт сейчас — над плитками. */
  now?: ReactNode;
  /** Поставить фокус на плитку при входе. Витрина набора `/kit` фокус страницы не забирает. */
  focusOnEnter?: boolean;
  /** Под плитками: сноски, ошибки, действия группы. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const target = useRef<HTMLButtonElement>(null);
  const open = tiles.filter((tile) => !tile.disabled);
  const focused = open.find((tile) => tile.id === last) ?? open[0];
  /*
    Нажатая карточка витрины уходит вместе с витриной, и фокус клавиатуры падал на страницу. Теперь
    он встаёт на плитку прошлого выбора (или первую): Enter ведёт туда же, Tab — дальше по списку.
    Только при входе: список, который дорисовался позже, фокус не дёргает.
  */
  useEffect(() => {
    if (focusOnEnter) target.current?.focus({ preventScroll: true });
    // Только при входе: смена `focusOnEnter` потом ничего не значит.
  }, []);
  return (
    <div className={className ? `platform-picker ${className}` : 'platform-picker'}>
      <Button
        variant="quiet"
        size="sm"
        className="platform-picker__back"
        icon={<ArrowLeft />}
        onClick={onBack}
      >
        {backLabel}
      </Button>
      <div className="platform-picker__head">
        <h3 className="platform-picker__title">{title}</h3>
        <p className="platform-picker__lead">{t(($) => $.integrations.pick)}</p>
      </div>
      {now && <div className="platform-picker__now">{now}</div>}
      <div className="service-tiles" role="group" aria-label={label}>
        {tiles.map((tile) => (
          <button
            key={tile.id}
            ref={tile === focused ? target : undefined}
            type="button"
            className="service-tile"
            style={paint(tile)}
            disabled={tile.disabled}
            data-last={tile.id === last || undefined}
            onClick={() => onPick(tile.id)}
          >
            <span className="service-tile-icon" aria-hidden="true">
              <tile.icon size={22} />
            </span>
            <span className="service-tile__text">
              {/* Отметка — в строке имени, как «Скоро» у витрины: справа она сжимала бы подсказку. */}
              <span className="service-tile__name">
                <b>{tile.name}</b>
                {tile.id === last && <Badge variant="accent">{t(($) => $.integrations.last)}</Badge>}
              </span>
              <small>{tile.note}</small>
            </span>
          </button>
        ))}
      </div>
      {children}
    </div>
  );
}

/**
 * Площадки вкладками — сменить площадку, не возвращаясь к выбору (музыка, T59). Те же имя, знак и
 * цвет, что у плиток; выбранная залита цветом площадки, как вкладки каталога кинозала. Строка
 * переносится: четыре имени в узкую панель не помещаются, а прятать имена за знаками — гадать.
 * Стрелки, Home и End ходят по вкладкам и сразу переключают: смена площадки ничего не грузит.
 */
export function PlatformTabs<Id extends string>({
  label,
  tiles,
  current,
  onPick,
}: {
  label: string;
  tiles: readonly PlatformTile<Id>[];
  current: Id;
  onPick: (id: Id) => void;
}) {
  const buttons = useRef(new Map<Id, HTMLButtonElement>());
  const step = (event: KeyboardEvent, index: number) => {
    const next =
      event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'ArrowLeft'
          ? index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tiles.length - 1
              : null;
    if (next === null || !tiles.length) return;
    event.preventDefault();
    const tile = tiles[(next + tiles.length) % tiles.length]!;
    onPick(tile.id);
    buttons.current.get(tile.id)?.focus();
  };
  return (
    <div className="platform-tabs" role="tablist" aria-label={label}>
      {tiles.map((tile, index) => (
        <button
          key={tile.id}
          ref={(node) => {
            if (node) buttons.current.set(tile.id, node);
            else buttons.current.delete(tile.id);
          }}
          type="button"
          role="tab"
          className="platform-tab"
          style={paint(tile)}
          aria-selected={tile.id === current}
          tabIndex={tile.id === current ? 0 : -1}
          onClick={() => onPick(tile.id)}
          onKeyDown={(event) => step(event, index)}
        >
          <tile.icon size={15} aria-hidden="true" />
          {tile.name}
        </button>
      ))}
    </div>
  );
}
