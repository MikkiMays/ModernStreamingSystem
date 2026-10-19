import { Settings2 } from 'lucide-react';
import type { Destination } from '../core/invitation';
import { IconButton } from './kit';
import { HomeEntry } from './HomeEntry';

export function DesktopHome({
  onCreate,
  onJoin,
  onSettings,
}: {
  onSettings: () => void;
  onCreate: () => void;
  onJoin: (destination: Destination) => void;
}) {
  return (
    <main className="desktop-home">
      <IconButton label="Настройки звука и профиля" className="desktop-home-settings" onClick={onSettings}>
        <Settings2 size={18} />
      </IconButton>
      <HomeEntry className="desktop-connect" onCreate={onCreate} onJoin={onJoin} />
    </main>
  );
}
