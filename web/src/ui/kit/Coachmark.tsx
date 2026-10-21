import { Popover } from '@base-ui/react/popover';
import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Подсказка у настоящей кнопки (E13, T34): карточка с выемкой, которая смотрит на кнопку, — не
 * слайд и не затемнение. Кнопка под подсказкой подсвечена кольцом (`data-coachmark-target`) и
 * остаётся рабочей: страница под подсказкой не заперта (`modal={false}`), нажать можно и саму
 * кнопку, и что угодно рядом.
 *
 * Закрыть можно своими кнопками, Esc и нажатием мимо — все три говорят `onDismiss`: подсказка
 * знакомства показывается один раз, и решать «закрыл случайно или нарочно» незачем.
 *
 * Слой — `--z-menu`: над панелями и пультом, под диалогами. Базой служит Popover Base UI — своей
 * библиотеки туров не понадобилось (решение E13-2).
 */
export interface CoachmarkProps {
  /** Кнопка, к которой подсказка. Нет кнопки — нет подсказки. */
  anchor: HTMLElement | null;
  title: string;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  /** «2 из 5» — для шага знакомства. */
  progress?: string;
  /** Главное действие: «Далее», «Готово», «Понятно». */
  action: string;
  onAction: () => void;
  /** Второе действие слева: «Пропустить». */
  secondary?: string;
  onSecondary?: () => void;
  /** Закрыли мимо кнопок: Esc или нажатие вне подсказки. */
  onDismiss: () => void;
}

export function Coachmark({
  anchor,
  title,
  children,
  side = 'bottom',
  align = 'center',
  progress,
  action,
  onAction,
  secondary,
  onSecondary,
  onDismiss,
}: CoachmarkProps) {
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!anchor) return;
    anchor.setAttribute('data-coachmark-target', '');
    return () => anchor.removeAttribute('data-coachmark-target');
  }, [anchor]);
  if (!anchor) return null;
  return (
    <Popover.Root
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          className="ui-coachmark__positioner"
          anchor={anchor}
          side={side}
          align={align}
          sideOffset={12}
          collisionPadding={12}
        >
          <Popover.Popup className="ui-coachmark" initialFocus={primary} finalFocus={false}>
            <Popover.Arrow className="ui-coachmark__arrow" />
            {progress && <span className="ui-coachmark__progress">{progress}</span>}
            <Popover.Title className="ui-coachmark__title">{title}</Popover.Title>
            <Popover.Description className="ui-coachmark__text">{children}</Popover.Description>
            <div className="ui-coachmark__actions">
              {secondary && (
                <button
                  type="button"
                  className="ui-button ui-button--quiet ui-button--sm"
                  onClick={onSecondary}
                >
                  <span className="ui-button__label">{secondary}</span>
                </button>
              )}
              <button
                ref={primary}
                type="button"
                className="ui-button ui-button--primary ui-button--sm"
                onClick={onAction}
              >
                <span className="ui-button__label">{action}</span>
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
