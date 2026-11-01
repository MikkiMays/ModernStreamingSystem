import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Свои инструменты доски — среди инструментов Excalidraw (R174), а не кнопками в шапке: на компьютере — в
 * колонке инструментов (за пером и за текстом), на телефоне — в меню «Ещё инструменты» его верхней полосы
 * (рядом с рамкой и лазером): в саму полосу телефона ещё две кнопки не помещаются.
 *
 * Своих кнопок Excalidraw 0.18.1 не принимает: `UIOptions.tools` только прячет его собственные. Поэтому
 * место — узел, который доска ставит сразу за элементом Excalidraw (`anchor`) и держит там: полосу и меню
 * Excalidraw пересоздаёт (вид «только смотреть», телефон, открытие меню) — узел встаёт на место по
 * первому же изменению их разметки. В узел React рисует порталом разметку самого Excalidraw (`ToolIcon`,
 * `dropdown-menu-item`) — вид, размер и выбранное состояние его. Версия закреплена; при смене — сверить
 * снимками.
 */
export function ToolSlot({
  root,
  anchor,
  kind,
  children,
}: {
  /** Где искать: холст доски. */
  root: HTMLElement | null;
  /** За каким элементом Excalidraw встать; `null` — его сейчас нет. */
  anchor: (root: HTMLElement) => Element | null;
  /** Полоса компьютера или меню телефона — `board.css` показывает только своё. */
  kind: 'bar' | 'menu';
  children: ReactNode;
}) {
  const [host] = useState(() => {
    const node = document.createElement('span');
    node.className = `board-tool-slot board-tool-slot--${kind}`;
    return node;
  });
  const find = useRef(anchor);
  find.current = anchor;
  useEffect(() => {
    if (!root) return;
    const place = () => {
      const at = find.current(root);
      if (!at) host.remove();
      else if (at.nextElementSibling !== host) at.after(host);
    };
    place();
    // Только состав узлов, без атрибутов: своя вставка — одна запись, после неё узел уже на месте.
    const observer = new MutationObserver(place);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      host.remove();
    };
  }, [root, host]);
  return createPortal(children, host);
}

/** Инструмент Excalidraw в полосе компьютера: `ToolIcon` с флажком (как его замок). */
export const barAnchor = (tool: string) => (root: HTMLElement) =>
  root.querySelector(`.App-toolbar [data-testid="toolbar-${tool}"]`)?.closest('.ToolIcon') ?? null;

/** Пункт меню «Ещё инструменты» Excalidraw (оно открыто — есть и пункт). */
export const menuAnchor = (tool: string) => (root: HTMLElement) =>
  root.querySelector(`.App-toolbar__extra-tools-dropdown [data-testid="toolbar-${tool}"]`);

/**
 * Инструмент Cord в колонке: та же разметка, что у замка Excalidraw (флажок в `ToolIcon`), — включён или
 * нет. `onToggle(keyboard)`: с клавиатуры поставить стикер «нажатием по доске» нельзя — его кладут посреди
 * вида.
 */
export function ToolToggle({
  name,
  label,
  title,
  icon,
  checked,
  onToggle,
}: {
  name: string;
  label: string;
  title: string;
  icon: ReactNode;
  checked: boolean;
  onToggle: (keyboard: boolean) => void;
}) {
  // Нажатие мышью или пальцем приходит с `pointerdown` раньше; без него — это пробел на флажке.
  const pointer = useRef(false);
  return (
    <label
      className="ToolIcon Shape board-tool"
      title={title}
      data-board-tool={name}
      onPointerDown={() => {
        pointer.current = true;
      }}
    >
      <input
        type="checkbox"
        className="ToolIcon_type_checkbox ToolIcon_size_medium"
        aria-label={label}
        checked={checked}
        onChange={() => {
          const keyboard = !pointer.current;
          pointer.current = false;
          onToggle(keyboard);
        }}
      />
      <div className="ToolIcon__icon" aria-hidden="true">
        {icon}
      </div>
    </label>
  );
}

/**
 * Инструмент Cord пунктом меню «Ещё инструменты» на телефоне — разметка пункта Excalidraw. Выбрал — меню
 * закрывается тем же переключателем, которым открылось (своего «закрыть» меню наружу не даёт).
 */
export function MenuTool({
  name,
  label,
  icon,
  checked,
  onPick,
}: {
  name: string;
  label: string;
  icon: ReactNode;
  checked: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className={`dropdown-menu-item dropdown-menu-item-base${checked ? ' dropdown-menu-item--selected' : ''}`}
      data-board-tool={name}
      aria-pressed={checked}
      onClick={(event) => {
        const trigger = event.currentTarget
          .closest('.excalidraw')
          ?.querySelector<HTMLElement>('.App-toolbar__extra-tools-trigger');
        onPick();
        trigger?.click();
      }}
    >
      <div className="dropdown-menu-item__icon" aria-hidden="true">
        {icon}
      </div>
      <div className="dropdown-menu-item__text">{label}</div>
    </button>
  );
}
