import { LayoutGrid, UserSquare } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import type { StageLayout } from '../core/preferences';
import { IconButton, Menu, MenuContent, MenuItem, MenuTrigger } from './kit';
import { useStore } from './primitives';

/**
 * Как расставить участников.
 *
 * Выбор принадлежит смотрящему, а не комнате: на телефоне в портрете сетка из двух колонок
 * даёт две марки вместо двух лиц, а на мониторе она же — то, что нужно. Договариваться об
 * этом с собеседником не о чем, поэтому настройка живёт на устройстве.
 */
const LAYOUTS: { value: StageLayout; title: string; icon: typeof LayoutGrid }[] = [
  { value: 'grid', title: 'Сетка', icon: LayoutGrid },
  { value: 'speaker', title: 'Говорящий', icon: UserSquare },
];

function apply(meeting: Meeting, layout: StageLayout) {
  meeting.media.saveSettings({ layout });
}

/** Тихий значок справа от пульта: раскладку меняют редко, и в группах ей не место. */
export function LayoutMenu({ meeting }: { meeting: Meeting }) {
  const layout = useStore(meeting.media.preferences).layout;
  const Current = LAYOUTS.find((item) => item.value === layout)?.icon ?? LayoutGrid;
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton tone="stage" className="dock-tool" label="Расположение участников">
            <Current size={20} />
          </IconButton>
        }
      />
      <MenuContent side="top" align="end" sideOffset={12}>
        <LayoutChoices meeting={meeting} />
      </MenuContent>
    </Menu>
  );
}

/** Те же пункты, но внутри чужого меню: на телефоне отдельной кнопке места нет. */
export function LayoutChoices({ meeting }: { meeting: Meeting }) {
  const layout = useStore(meeting.media.preferences).layout;
  return (
    <>
      {LAYOUTS.map((item) => (
        <MenuItem
          key={item.value}
          icon={<item.icon />}
          shortcut={item.value === layout ? '✓' : undefined}
          onClick={() => apply(meeting, item.value)}
        >
          {item.title}
        </MenuItem>
      ))}
    </>
  );
}
