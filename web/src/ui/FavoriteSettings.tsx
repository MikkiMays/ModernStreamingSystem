import { MoreHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { autoJoinEnabled, setAutoJoin, type Favorite } from '../core/favorites';
import { IconButton, Modal } from './primitives';

export function FavoriteSettings({
  room,
  removing,
  remove,
  initiallyOpen = false,
  onClose,
}: {
  initiallyOpen?: boolean;
  onClose?: () => void;
  room: Favorite;
  removing: boolean;
  remove: () => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(initiallyOpen);
  const [automatic, setAutomatic] = useState(() => autoJoinEnabled(room.roomId));
  return (
    <>
      {!initiallyOpen && (
        <IconButton label={`Настроить вход в «${room.title}»`} onClick={() => setOpen(true)}>
          <MoreHorizontal size={19} />
        </IconButton>
      )}
      <Modal
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (!value) onClose?.();
        }}
        title={room.title}
        description="Настройки входа на этом устройстве."
      >
        <label className="check-setting favorite-auto">
          <input
            type="checkbox"
            role="switch"
            checked={automatic}
            onChange={(e) => {
              setAutomatic(e.target.checked);
              setAutoJoin(room.roomId, e.target.checked);
            }}
          />
          Автоподключение
        </label>
        <p className="muted">
          Открывать эту комнату сразу, без предпросмотра. Микрофон включится при входе, камера останется
          выключенной.
        </p>
        <button
          className="button secondary full"
          disabled={removing || busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await remove();
              setOpen(false);
              onClose?.();
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Trash2 size={17} />
          Убрать из избранного
        </button>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </Modal>
    </>
  );
}
