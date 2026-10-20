import { MoreHorizontal, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(initiallyOpen);
  const [automatic, setAutomatic] = useState(() => autoJoinEnabled(room.roomId));
  return (
    <>
      {!initiallyOpen && (
        <IconButton
          label={t(($) => $.favorites.settings.open, { title: room.title })}
          onClick={() => setOpen(true)}
        >
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
        description={t(($) => $.favorites.settings.description)}
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
          {t(($) => $.favorites.settings.autojoin)}
        </label>
        <p className="muted">{t(($) => $.favorites.settings.autojoinHint)}</p>
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
          {t(($) => $.favorites.settings.remove)}
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
