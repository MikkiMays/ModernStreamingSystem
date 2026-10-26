import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeft, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import type { PlatformArea } from '../core/preferences';
import { paint, type BrandId } from './brands';
import { Badge, Button, Tab, TabList, Tabs } from './kit';
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
  /** Подпись вкладки, если полное имя в плеер не входит: «Яндекс», «Файлы». */
  short?: string;
  /** Бренд площадки (`ui/brands.ts`): плашка знака на плитке выбора и знак источника в плеере. */
  brand: BrandId;
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
            style={paint(tile.brand)}
            disabled={tile.disabled}
            data-last={tile.id === last || undefined}
            onClick={() => onPick(tile.id)}
          >
            <span className="service-tile-icon" aria-hidden="true">
              <tile.icon size={20} />
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
 * Площадки вкладками внутри плеера (R44, R128): сменить площадку, где искать, не уходя из музыки.
 * Рисунок — общий переключатель набора (`Tabs segmented sm`, R123: дорожка и плашка в целых
 * физических пикселях), а не свой: прежние вкладки красили выбранную цветом площадки и рисовали
 * плашку темнее дорожки. Здесь всё монохромно — цвет площадки остаётся только у знака источника
 * в «Сейчас играет».
 *
 * Подпись — короткое имя («Яндекс», «Файлы»): четыре полных имени со значками в панель 360 не
 * входят. Полное имя — у вкладки для диктора и подсказкой; в узкой панели (`integrations.css`)
 * значков нет, в самой узкой остаются одни значки. Стрелки, Home и End ходят по вкладкам и сразу
 * переключают: смена площадки ничего не грузит. Площадка, до которой сервер не достаёт (`down`,
 * R112), — приглушённая, с причиной в подсказке; выбрать её можно: там «Повторить».
 */
export function PlatformTabs<Id extends string>({
  label,
  tiles,
  current,
  onPick,
  down,
}: {
  label: string;
  tiles: readonly PlatformTile<Id>[];
  current: Id;
  onPick: (id: Id) => void;
  /** Почему площадка недоступна с этого сервера — или `null`, если доступна. */
  down?: (id: Id) => string | null;
}) {
  return (
    <Tabs value={current} onValueChange={(value) => onPick(value as Id)} size="sm" className="platform-tabs">
      <TabList activateOnFocus aria-label={label}>
        {tiles.map((tile) => {
          const reason = down?.(tile.id) ?? null;
          return (
            <Tab
              key={tile.id}
              value={tile.id}
              className="platform-tab"
              icon={<tile.icon />}
              aria-label={tile.name}
              title={reason ?? tile.name}
              data-reach={reason ? 'down' : undefined}
            >
              {tile.short ?? tile.name}
            </Tab>
          );
        })}
      </TabList>
    </Tabs>
  );
}
