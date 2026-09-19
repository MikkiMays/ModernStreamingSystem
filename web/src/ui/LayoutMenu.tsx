import { Menu } from '@base-ui/react/menu';
import { LayoutGrid, UserSquare } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import type { StageLayout } from '../core/preferences';
import { IconButton, useStore } from './primitives';

/**
 * Как расставить участников.
 *
 * Выбор принадлежит смотрящему, а не комнате: на телефоне в портрете сетка из двух колонок
 * даёт две марки вместо двух лиц, а на мониторе она же — то, что нужно. Договариваться об
 * этом с собеседником не о чем, поэтому настройка живёт на устройстве.
 */
const LAYOUTS: { value: StageLayout; title: string; hint: string; icon: typeof LayoutGrid }[] = [
  { value: 'grid', title: 'Сетка', hint: 'Все одинакового размера', icon: LayoutGrid },
  { value: 'speaker', title: 'Говорящий', hint: 'Крупно тот, кто говорит', icon: UserSquare },
];

function apply(meeting: Meeting, layout: StageLayout) {
  meeting.media.saveSettings({ layout });
}

export function LayoutMenu({ meeting }: { meeting: Meeting }) {
  const layout = useStore(meeting.media.preferences).layout;
  const Current = LAYOUTS.find((item) => item.value === layout)?.icon ?? LayoutGrid;
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <IconButton label="Расположение участников">
            <Current size={21} />
          </IconButton>
        }
      />
      <Menu.Portal>
        <Menu.Positioner side="top" sideOffset={12}>
          <Menu.Popup className="action-menu">
            {LAYOUTS.map((item) => (
              <Menu.Item key={item.value} onClick={() => apply(meeting, item.value)}>
                <item.icon size={18} /> {item.title}
                {item.value === layout ? ' ·' : ''}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Те же пункты, но внутри чужого меню: на телефоне отдельной кнопке места нет. */
export function LayoutChoices({ meeting }: { meeting: Meeting }) {
  const layout = useStore(meeting.media.preferences).layout;
  return (
    <>
      {LAYOUTS.map((item) => (
        <Menu.Item key={item.value} onClick={() => apply(meeting, item.value)}>
          <item.icon size={18} /> {item.title}
          {item.value === layout ? ' ·' : ''}
        </Menu.Item>
      ))}
    </>
  );
}
