import { useEffect } from 'react';
import { onDesktopCommand } from '../core/desktop';
import type { Panel } from './Sidebar';

/**
 * «Чат · N» в меню трея клиента Windows (R103): окно оболочка уже подняла, а открыть чат встречи
 * просит событием `chat.open`. Чат открывается, а не переключается: уже открытый так и остаётся —
 * человек пришёл из трея читать, а не закрывать. Без встречи событие слушать некому, и оно пропадает.
 */
export function useTrayChat(setPanel: (panel: Panel) => void) {
  useEffect(
    () =>
      onDesktopCommand((command) => {
        if (command.type === 'chat.open') setPanel('chat');
      }),
    [setPanel],
  );
}
