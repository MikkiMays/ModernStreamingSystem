import { ArrowRight, Star, Settings2, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DownloadLink, IconButton, Logo, Modal, ThemeButton, type Theme } from './primitives';
import { favoriteApi } from '../core/favorites';
import { useFavorites, useReorderFavorites } from './useFavorites';
import { InstallHint } from './InstallHint';
import { appLabel } from '../core/version';
import { DesktopHome } from './DesktopHome';
import { HomeEntry } from './HomeEntry';
import { Settings } from './Settings';
import { FavoriteSettings } from './FavoriteSettings';
import { formatCode, type Destination } from '../core/invitation';
import { FavoriteReorder } from './favorite-reorder';
export { formatCode, parseInvite, type Destination } from '../core/invitation';
export { ThemeButton, type Theme } from './primitives';
interface HomeProps {
  onCreate: () => void;
  onJoin: (destination: Destination) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /** A settings section the host asked to open, and the way to say it has been closed. */
  section?: string;
  onSectionClosed?: () => void;
}
export function Home(props: HomeProps) {
  const [settings, setSettings] = useState(false);
  // Раздел, с которого открыться. Просит либо оболочка, либо строка версии внизу страницы.
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
      {window.chrome?.webview ? (
        <DesktopHome {...props} onSettings={() => open()} />
      ) : (
        <BrowserHome {...props} onSettings={open} />
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
function BrowserHome({
  onCreate,
  onJoin,
  theme,
  setTheme,
  onSettings,
}: HomeProps & { onSettings: (section?: string) => void }) {
  const [showFavorites, setShowFavorites] = useState(false);
  const [favoriteError, setFavoriteError] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const favorites = useFavorites();
  const reorder = useReorderFavorites();
  return (
    <div className="home-page home-shell">
      <header className="app-header">
        <Logo />
        <div className="header-end">
          <button
            type="button"
            className="home-favorites-trigger"
            aria-label="Избранные комнаты"
            aria-haspopup="dialog"
            onClick={() => setShowFavorites(true)}
          >
            <Star size={18} aria-hidden="true" />
            <span>Избранное</span>
          </button>
          <DownloadLink />
          <ThemeButton theme={theme} setTheme={setTheme} />
          <IconButton label="Настройки" onClick={() => onSettings()}>
            <Settings2 size={20} />
          </IconButton>
        </div>
      </header>
      <main className="home-entry-main">
        <HomeEntry onCreate={onCreate} onJoin={onJoin} />
      </main>
      <footer className="home-shell-footer">
        <span className="home-privacy-note">
          <ShieldCheck size={15} aria-hidden="true" /> Без аккаунта. На вашем сервере.
        </span>
        <button className="build-label" onClick={() => onSettings('about')}>
          Cord {appLabel}
        </button>
      </footer>
      <InstallHint />
      <Modal
        open={showFavorites}
        onOpenChange={setShowFavorites}
        title="Избранные комнаты"
        description="Сохранённые встречи на этом сервере."
      >
        <div className="home-favorites-content">
          {!!favorites.data?.length ? (
            <FavoriteReorder
              className="recent-list"
              rooms={favorites.data}
              pending={reorder.isPending}
              reorder={(roomIds) => reorder.mutate(roomIds)}
            >
              {(room) => (
                <div key={room.roomId} className="favorite-row">
                  <button
                    className="recent-room"
                    disabled={!room.canJoin}
                    onClick={() => {
                      setShowFavorites(false);
                      onJoin({ kind: 'favorite', favorite: room });
                    }}
                  >
                    <span className="recent-icon">
                      <Star size={18} aria-hidden="true" />
                    </span>
                    <span>
                      <strong>{room.title}</strong>
                      <small>
                        {formatCode(room.code)}
                        {!room.canJoin && ' · Комната больше не помнит вас'}
                      </small>
                    </span>
                    <ArrowRight size={18} aria-hidden="true" />
                  </button>
                  <FavoriteSettings
                    room={room}
                    removing={removing === room.roomId || reorder.isPending}
                    remove={async () => {
                      setRemoving(room.roomId);
                      setFavoriteError('');
                      try {
                        await favoriteApi.remove(room.roomId);
                        await favorites.refetch();
                      } catch (error) {
                        setFavoriteError((error as Error).message);
                      } finally {
                        setRemoving(null);
                      }
                    }}
                  />
                </div>
              )}
            </FavoriteReorder>
          ) : favorites.isPending ? (
            <p className="muted" role="status">
              Загружаем избранное…
            </p>
          ) : !favorites.isError ? (
            <div className="home-favorites-empty">
              <Star size={24} aria-hidden="true" />
              <strong>Здесь будут ваши встречи</strong>
              <p>Нажмите звёздочку во встрече, чтобы легко вернуться к ней.</p>
            </div>
          ) : null}
          {favorites.isError && (
            <p className="form-error" role="status">
              Не удалось загрузить избранное.{' '}
              <button
                className="text-button"
                disabled={favorites.isFetching}
                onClick={() => void favorites.refetch()}
              >
                Повторить
              </button>
            </p>
          )}
          {(favoriteError || reorder.isError) && (
            <p className="form-error" role="alert">
              {favoriteError || (reorder.error as Error).message}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
