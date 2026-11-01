import { Tooltip } from '@base-ui/react/tooltip';
import { CircleHelp } from 'lucide-react';
import { useId, useState, type SyntheticEvent } from 'react';

/**
 * Маленький «?» с подсказкой по наведению (R173): пояснение к настройке, которое не нужно держать
 * строкой под ней. Мышью — наведением, касанием — нажатием на сам значок, с клавиатуры — фокусом
 * (`focusable`). Нажатие на значок не доходит до строки: в меню и в подписи переключателя оно не
 * переключает настройку.
 *
 * Для диктора пояснение — описанием строки (`describedBy`), а не частью её имени: имя настройки
 * остаётся прежним («Автоподключение»), и по нему её находят и люди, и тесты.
 */
export function HintIcon({
  text,
  label,
  focusable = false,
  id,
}: {
  text: string;
  /** Имя значка для диктора, когда он в фокусе (`focusable`). */
  label?: string;
  /** Значок — своя остановка Tab (в окне настроек); в меню — нет: там ходят по пунктам. */
  focusable?: boolean;
  /** Номер скрытого текста пояснения — для `aria-describedby` строки. */
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const own = useId();
  const described = id ?? own;
  const keep = (event: SyntheticEvent) => event.stopPropagation();
  return (
    <>
      <Tooltip.Root open={open} onOpenChange={setOpen}>
        <Tooltip.Trigger
          delay={150}
          render={
            <span
              className="ui-hint"
              role={focusable ? 'button' : undefined}
              tabIndex={focusable ? 0 : undefined}
              aria-label={focusable ? (label ?? text) : undefined}
              aria-hidden={focusable ? undefined : true}
              onPointerDown={keep}
              onMouseUp={keep}
              onClick={(event) => {
                // Касание: открыть подсказку, а не переключить строку, в которой значок стоит.
                event.preventDefault();
                event.stopPropagation();
                setOpen((value) => !value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && open) {
                  event.stopPropagation();
                  setOpen(false);
                }
              }}
            />
          }
        >
          <CircleHelp aria-hidden="true" />
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner className="ui-hint__layer" side="top" sideOffset={6}>
            <Tooltip.Popup className="ui-hint__popup">{text}</Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
      {/* Скрыт и от имени строки (`aria-hidden`), но читается её описанием: `aria-describedby` берёт и скрытое. */}
      <span id={described} className="ui-hint__text" aria-hidden="true">
        {text}
      </span>
    </>
  );
}
