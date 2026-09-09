import { MoreHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { autoJoinEnabled, setAutoJoin, type Favorite } from '../core/favorites';
import { IconButton, Modal } from './primitives';

export function FavoriteSettings({
  room,
  removing,
  remove,
}: {
  room: Favorite;
  removing: boolean;
  remove: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [automatic, setAutomatic] = useState(() => autoJoinEnabled(room.roomId));
  return (
    <>
      <IconButton label={`Настроить вход в «${room.title}»`} onClick={() => setOpen(true)}>
        <MoreHorizontal size={19} />
      </IconButton>
      <Modal
        open={open}
        onOpenChange={setOpen}
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
          disabled={removing}
          onClick={async () => {
            await remove();
            setOpen(false);
          }}
        >
          <Trash2 size={17} />
          Убрать из избранного
        </button>
      </Modal>
    </>
  );
}
