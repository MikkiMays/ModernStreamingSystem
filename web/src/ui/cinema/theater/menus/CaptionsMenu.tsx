import type { RefObject } from 'react';
import { Captions } from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import { useTranslation } from 'react-i18next';
import { IconButton } from '../../../primitives';
import type { CaptionChoice } from '../watch-tracks';

/**
 * Субтитры — отдельной кнопкой, а не строкой в шестерёнке: их включают и выключают посреди
 * просмотра, и у площадки они стоят ровно здесь же.
 */
export function CaptionsMenu({
  texts,
  text,
  caption,
  open,
  onOpenChange,
  container,
  onChoose,
}: {
  texts: CaptionChoice[];
  /** Какие включены: `id` из `texts`, пусто — выключены. */
  text: string;
  caption: CaptionChoice | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Куда класть меню: в сам плеер, иначе в полном экране его не видно (см. `WatchTheater`). */
  container: RefObject<HTMLDivElement | null>;
  onChoose: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger
        render={
          <IconButton
            label={
              caption
                ? t(($) => $.cinema.theater.captions.labelWith, { name: caption.label })
                : t(($) => $.cinema.theater.captions.label)
            }
            className={caption ? 'watch-on' : ''}
          >
            <Captions size={20} />
          </IconButton>
        }
      />
      <Menu.Portal container={container}>
        <Menu.Positioner className="menu-layer" side="top" sideOffset={10} align="end">
          <Menu.Popup className="action-menu watch-quality-menu">
            <Menu.Item data-selected={text ? undefined : 'true'} onClick={() => onChoose('')}>
              {t(($) => $.cinema.theater.captions.off)}
            </Menu.Item>
            {texts.map((item) => (
              <Menu.Item
                key={item.id}
                data-selected={text === item.id ? 'true' : undefined}
                onClick={() => onChoose(item.id)}
              >
                {item.label}
                {item.auto && <small>{t(($) => $.cinema.theater.captions.recognised)}</small>}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
