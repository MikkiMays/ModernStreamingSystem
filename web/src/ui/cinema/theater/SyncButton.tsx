import { RefreshCw } from 'lucide-react';
import { IconButton } from '../../primitives';

/**
 * «Встать на секунду комнаты» — своё действие, а не команда: комнату оно не двигает
 * (`resync` в `useRoomSync.ts`). Жёлтой кнопка становится, когда отставание уже видно глазом.
 */
export function SyncButton({ behind, onSync }: { behind: boolean; onSync: () => void }) {
  return (
    <IconButton label="Встать на секунду комнаты" className={behind ? 'watch-behind' : ''} onClick={onSync}>
      <RefreshCw size={17} />
    </IconButton>
  );
}
