import { useEffect, useState } from 'react';
import type { Admission } from '../api/types';
import { DesktopHome } from './DesktopHome';
import { hasFeature } from '../core/desktop';
import { HomeShell } from './home/HomeShell';
import { Settings } from './Settings';
import type { Theme } from './primitives';
import type { Destination } from '../core/invitation';
export { formatCode, parseInvite, type Destination } from '../core/invitation';
export { type Theme } from './primitives';
interface HomeProps {
  onCreate: () => void;
  onJoin: (destination: Destination) => void;
  /** Вернуться во встречу, идущую в соседней вкладке (T52). */
  onResume?: (admission: Admission) => void;
  /** Тема живёт в настройках (T41): главная только передаёт её туда. */
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** A settings section the host asked to open, and the way to say it has been closed. */
  section?: string;
  onSectionClosed?: () => void;
}
export function Home(props: HomeProps) {
  const [settings, setSettings] = useState(false);
  // Раздел, с которого открыться. Просит либо оболочка, либо ссылка «О программе» внизу страницы.
  const [section, setSection] = useState<string | undefined>(undefined);
  // The host can ask for a section by name — the profile block in its sidebar opens the page's
  // own profile settings, because that is where the picture lives.
  useEffect(() => {
    if (props.section) setSettings(true);
  }, [props.section]);
  const open = (named?: string) => {
    setSection(named);
    setSettings(true);
  };
  return (
    <>
      {/* Оболочка со своей боковой панелью (WinUI) получает узкую главную; Electron — всю главную веба. */}
      {hasFeature('sidebar') ? (
        <DesktopHome onCreate={props.onCreate} onJoin={props.onJoin} onSettings={() => open()} />
      ) : (
        <HomeShell
          onCreate={props.onCreate}
          onJoin={props.onJoin}
          onSettings={open}
          onResume={(admission) => props.onResume?.(admission)}
        />
      )}
      <Settings
        open={settings}
        section={props.section ?? section}
        theme={props.theme}
        setTheme={props.setTheme}
        onOpenChange={(shown) => {
          setSettings(shown);
          if (!shown) {
            setSection(undefined);
            props.onSectionClosed?.();
          }
        }}
      />
    </>
  );
}
