import { Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Destination } from '../core/invitation';
import { IconButton } from './kit';
import { HomeEntry } from './HomeEntry';
import { Ping } from './Ping';

export function DesktopHome({
  onCreate,
  onJoin,
  onSettings,
}: {
  onSettings: () => void;
  onCreate: () => void;
  onJoin: (destination: Destination) => void;
}) {
  const { t } = useTranslation();
  return (
    <main className="desktop-home">
      <IconButton
        label={t(($) => $.download.desktop.settings)}
        className="desktop-home-settings"
        data-tour="settings"
        onClick={onSettings}
      >
        <Settings2 size={18} />
      </IconButton>
      <HomeEntry className="desktop-connect" onCreate={onCreate} onJoin={onJoin} />
      {/* PING — строкой под входом, а не плашкой поверх (R20). */}
      <Ping />
    </main>
  );
}
