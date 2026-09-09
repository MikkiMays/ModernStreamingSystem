import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, AudioLines, ChevronDown, Hash, Plus, Star, X } from 'lucide-react';
import { publicApi } from '../api/client';
import { favoriteApi, type Favorite } from '../core/favorites';
import { formatCode, parseInvite, type Destination } from '../core/invitation';
import { IconButton, Modal } from './primitives';
import { useFavorites } from './useFavorites';

export function DesktopHome({
  onCreate,
  onJoin,
}: {
  onCreate: () => void;
  onJoin: (destination: Destination) => void;
}) {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const [showFavorites, setShowFavorites] = useState(false);
  const favorites = useFavorites();
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: publicApi.capabilities, retry: 1 });
  const remove = async (room: Favorite) => {
    setRemoving(room.roomId);
    try {
      await favoriteApi.remove(room.roomId);
      await favorites.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRemoving(null);
    }
  };
  const enter = (favorite: Favorite) => {
    setShowFavorites(false);
    onJoin({ kind: 'favorite', favorite });
  };
  const rooms = favorites.data ?? [];
  const list = (
    <div className="desktop-favorites-grid">
      {rooms.map((room) => (
        <div className="desktop-favorite" key={room.roomId}>
          <button
            className="desktop-favorite-enter"
            disabled={!room.canJoin}
            onClick={() => enter(room)}
            title={room.canJoin ? room.title : 'Доступ отозван организатором'}
          >
            <span className="desktop-room-hash">
              <Hash size={18} />
            </span>
            <span>
              <strong>{room.title}</strong>
              <small>{formatCode(room.code)}</small>
            </span>
          </button>
          <IconButton
            label={`Убрать «${room.title}» из избранного`}
            disabled={removing === room.roomId}
            onClick={() => void remove(room)}
          >
            <X size={15} />
          </IconButton>
        </div>
      ))}
    </div>
  );
  return (
    <main className="desktop-home">
      <section className="desktop-connect" aria-labelledby="desktop-home-title">
        <header className="desktop-welcome">
          <span className="desktop-wave" aria-hidden="true">
            <AudioLines size={26} />
          </span>
          <h1 id="desktop-home-title">Начнём разговор.</h1>
          <p>Одна комната. Все свои.</p>
        </header>
        <form
          className="desktop-join"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              setError('');
              onJoin(parseInvite(link));
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <label htmlFor="desktop-invite">Код встречи или ссылка</label>
          <div className="desktop-join-row">
            <div className="input-icon">
              <Hash size={18} />
              <input
                id="desktop-invite"
                value={link}
                onChange={(e) =>
                  setLink(/^[\d\s-]*$/.test(e.target.value) ? formatCode(e.target.value) : e.target.value)
                }
                placeholder="333-333-333"
                autoComplete="off"
                required
                aria-describedby="desktop-code-hint"
              />
            </div>
            <button className="button primary desktop-join-submit" type="submit" aria-label="Присоединиться">
              <ArrowRight size={20} />
            </button>
          </div>
          <small id="desktop-code-hint">Вход по коду подтвердит организатор.</small>
        </form>
        <button
          className="button secondary desktop-create"
          onClick={onCreate}
          disabled={capabilities.data?.admissionOpen === false}
        >
          <Plus size={19} /> Новая встреча
        </button>
        {error && (
          <p className="form-error desktop-home-error" role="alert">
            {error}
          </p>
        )}
        <section className="desktop-favorites" aria-label="Избранные комнаты">
          <div className="desktop-favorites-heading">
            <span>
              <Star size={14} /> Избранные комнаты
            </span>
            <span>{rooms.length} / 5</span>
          </div>
          <div className="desktop-favorites-expanded">
            {rooms.length ? (
              list
            ) : (
              <p className="desktop-favorites-empty">Сохраните встречу звёздочкой — она появится здесь.</p>
            )}
          </div>
          <button
            className="button secondary desktop-favorites-compact"
            onClick={() => setShowFavorites(true)}
          >
            Открыть избранное <ChevronDown size={16} />
          </button>
          {favorites.isError && (
            <button className="text-button desktop-favorites-retry" onClick={() => void favorites.refetch()}>
              Повторить загрузку избранного
            </button>
          )}
        </section>
        {capabilities.isError && (
          <p className="desktop-service-note" role="status">
            Сервер недоступен. Проверьте адрес в настройках.
          </p>
        )}
      </section>
      <Modal
        open={showFavorites}
        onOpenChange={setShowFavorites}
        title="Избранные комнаты"
        description="До пяти комнат, в которые можно вернуться."
      >
        {rooms.length ? list : <p className="muted">Добавьте комнату звёздочкой во время встречи.</p>}
      </Modal>
    </main>
  );
}
