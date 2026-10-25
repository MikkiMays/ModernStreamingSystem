import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '../../primitives';

/**
 * «Встать на секунду комнаты» — своё действие, а не команда: комнату оно не двигает
 * (`resync` в `useRoomSync.ts`). Жёлтой кнопка становится, когда отставание уже видно глазом.
 */
export function SyncButton({ behind, onSync }: { behind: boolean; onSync: () => void }) {
  const { t } = useTranslation();
  return (
    <IconButton
      label={t(($) => $.cinema.theater.sync)}
      className={behind ? 'watch-behind' : ''}
      onClick={onSync}
    >
      <RefreshCw size={20} />
    </IconButton>
  );
}
