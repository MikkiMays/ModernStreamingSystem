import type { RefObject } from 'react';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import { levelLabel, type Level, type Quality } from '../watch-levels';
import type { AudioChoice } from '../watch-tracks';

/** Какая страница открыта в шестерёнке: сам список разделов, качество или язык звука. */
export type QualityPage = 'root' | 'quality' | 'voice';

/** Шестерёнка: качество картинки и язык озвучки. Оба выбора личные — комната о них не знает. */
export function QualityMenu({
  open,
  onOpenChange,
  page,
  onPage,
  container,
  levels,
  level,
  automatic,
  choices,
  voices,
  voice,
  onLevel,
  onVoice,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  page: QualityPage;
  onPage: (page: QualityPage) => void;
  /** Куда класть меню: в сам плеер, иначе в полном экране его не видно (см. `WatchTheater`). */
  container: RefObject<HTMLDivElement | null>;
  levels: Level[];
  /** Ступень, выбранная руками: номер в `levels`, `-1` — автоматически. */
  level: number;
  /** Какую ступень автоматика играет сейчас. */
  automatic: number;
  choices: Quality[];
  voices: AudioChoice[];
  voice: number;
  onLevel: (index: number) => void;
  onVoice: (choice: AudioChoice) => void;
}) {
  const chosen = level >= 0 ? levelLabel(levels[level]) : '';
  return (
    <Menu.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        // Закрылось — значит, в следующий раз открывается с разделов, а не там,
        // где его бросили: список языков без заголовка читается как весь список.
        if (!next) onPage('root');
      }}
    >
      <Menu.Trigger
        render={
          <button className="watch-quality" aria-label="Качество картинки и язык звука">
            <Settings2 size={17} />
            <span>{chosen || 'Авто'}</span>
          </button>
        }
      />
      <Menu.Portal container={container}>
        <Menu.Positioner className="menu-layer" side="top" sideOffset={10} align="end">
          <Menu.Popup className="action-menu watch-quality-menu">
            {/*
              Два раздела, а не один список.

              Раньше озвучки и качества лежали друг под другом, разделённые только
              подписями: у ролика с двумя десятками переозвучек это полтора экрана
              прокрутки, в конце которых — «Автоматически». Теперь сначала вопрос
              («что менять»), потом ответы; каждый раздел показывает выбранное
              прямо в строке, так что заходить ради проверки не нужно.
            */}
            {page === 'root' && (
              <>
                {voices.length > 1 && (
                  <Menu.Item closeOnClick={false} onClick={() => onPage('voice')}>
                    Язык озвучки
                    <small>{voices.find((item) => item.index === voice)?.label ?? 'Авто'}</small>
                  </Menu.Item>
                )}
                {choices.length > 1 && (
                  <Menu.Item closeOnClick={false} onClick={() => onPage('quality')}>
                    Качество
                    <small>
                      {level < 0
                        ? `Авто${automatic >= 0 ? ` · ${levelLabel(levels[automatic])}` : ''}`
                        : chosen}
                    </small>
                  </Menu.Item>
                )}
              </>
            )}
            {page !== 'root' && (
              <button type="button" className="watch-menu-back" onClick={() => onPage('root')}>
                <ArrowLeft size={15} />
                {page === 'voice' ? 'Язык озвучки' : 'Качество'}
              </button>
            )}
            {page === 'voice' &&
              voices.map((item) => (
                <Menu.Item
                  key={item.index}
                  data-selected={voice === item.index ? 'true' : undefined}
                  onClick={() => onVoice(item)}
                >
                  {item.label}
                  {item.original && <small>оригинал</small>}
                </Menu.Item>
              ))}
            {page === 'quality' && (
              <>
                <Menu.Item data-selected={level < 0 ? 'true' : undefined} onClick={() => onLevel(-1)}>
                  Автоматически
                  {level < 0 && automatic >= 0 && <small>{levelLabel(levels[automatic])}</small>}
                </Menu.Item>
                {choices.map((choice) => (
                  <Menu.Item
                    key={choice.label}
                    data-selected={level === choice.level ? 'true' : undefined}
                    onClick={() => onLevel(choice.level)}
                  >
                    {choice.label}
                  </Menu.Item>
                ))}
              </>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
