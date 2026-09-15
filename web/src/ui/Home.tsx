import { ArrowDownLeft, ArrowRight, Link, Plus, Video, Star, ShieldCheck, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../api/client';
import { DownloadLink, IconButton, Logo, ThemeButton, type Theme } from './primitives';
import { favoriteApi } from '../core/favorites';
import { useFavorites } from './useFavorites';
import { DesktopHome } from './DesktopHome';
import { Settings } from './Settings';
import { FavoriteSettings } from './FavoriteSettings';
import { formatCode, parseInvite, type Destination } from '../core/invitation';
export { formatCode, parseInvite, type Destination } from '../core/invitation';
// The theme control lives with the other primitives so the connect screen can use it without
// pulling in the whole home page.
export { ThemeButton, type Theme } from './primitives';
interface HomeProps {
  onCreate: () => void;
  onJoin: (destination: Destination) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}
export function Home(props: HomeProps) {
  const [settings, setSettings] = useState(false);
  return (
    <>
      {window.chrome?.webview ? (
        <DesktopHome {...props} onSettings={() => setSettings(true)} />
      ) : (
        <BrowserHome {...props} onSettings={() => setSettings(true)} />
      )}
      <Settings open={settings} onOpenChange={setSettings} />
    </>
  );
}
function BrowserHome({
  onCreate,
  onJoin,
  theme,
  setTheme,
  onSettings,
}: HomeProps & { onSettings: () => void }) {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: publicApi.capabilities, retry: 1 });
  const favorites = useFavorites();
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <div className="home-page">
      <header className="app-header">
        <Logo />
        <div className="header-end">
          <span className="header-note">Пространство для общения</span>
          <DownloadLink />
          <ThemeButton theme={theme} setTheme={setTheme} />
          <IconButton label="Настройки" onClick={onSettings}>
            <Settings2 size={20} />
          </IconButton>
        </div>
      </header>
      <main className="home-main">
        <div className="eyebrow">
          <span className="status-dot" /> ВАШ СЛЕДУЮЩИЙ РАЗГОВОР
        </div>
        <h1>На одной волне.</h1>
        <p className="home-intro">
          Встречайтесь, показывайте, делитесь.
          <br />
          Всё нужное — в одной комнате.
        </p>
        <div className="home-actions">
          <button
            className="create-card"
            onClick={onCreate}
            disabled={capabilities.data?.admissionOpen === false}
          >
            <span className="create-top">
              <span className="action-icon">
                <Video size={28} />
              </span>
              <Plus size={26} />
            </span>
            <span className="create-title">Новая встреча</span>
            <span className="create-description">Начните разговор и пригласите своих</span>
            <span className="create-bottom">
              Создать комнату <ArrowRight size={22} />
            </span>
          </button>
          <form
            className="join-card"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                setError('');
                onJoin(parseInvite(link));
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <span className="action-icon secondary">
              <ArrowDownLeft size={28} />
            </span>
            <h2>Вас уже ждут?</h2>
            <p className="muted">
              Введите код или откройте приглашение.
              <br />
              Без аккаунта и лишних шагов.
            </p>
            <label htmlFor="invite-link">Код встречи или ссылка</label>
            <div className="input-icon">
              <Link size={18} />
              <input
                id="invite-link"
                type="text"
                value={link}
                onChange={(e) =>
                  setLink(/^[\d\s-]*$/.test(e.target.value) ? formatCode(e.target.value) : e.target.value)
                }
                placeholder="333-333-333"
                autoComplete="off"
                required
              />
            </div>
            <small className="join-code-hint">По коду организатор подтвердит ваш вход.</small>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <button className="button secondary full" type="submit">
              Присоединиться <ArrowRight size={18} />
            </button>
          </form>
        </div>
        <section className="recent-section">
          <div className="section-title">
            <h2>Избранные комнаты</h2>
            <span>{favorites.data?.length ?? 0} / 5</span>
          </div>
          {!!favorites.data?.length ? (
            <div className="recent-list">
              {favorites.data.map((room) => (
                <div key={room.roomId} className="favorite-row">
                  <button
                    className="recent-room"
                    disabled={!room.canJoin}
                    onClick={() => onJoin({ kind: 'favorite', favorite: room })}
                  >
                    <span className="recent-icon">
                      <Star size={20} />
                    </span>
                    <span>
                      <strong>{room.title}</strong>
                      <small>
                        {formatCode(room.code)} ·{' '}
                        {room.canJoin ? 'Можно вернуться в любое время' : 'Доступ отозван организатором'}
                      </small>
                    </span>
                    <ArrowRight size={18} />
                  </button>
                  <FavoriteSettings
                    room={room}
                    removing={removing === room.roomId}
                    remove={async () => {
                      setRemoving(room.roomId);
                      try {
                        await favoriteApi.remove(room.roomId);
                        await favorites.refetch();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        setRemoving(null);
                      }
                    }}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="recent-empty">
              <Star size={22} />
              <div>
                Ваши люди, одно место
                <small>Нажмите звёздочку во встрече. Сохранённая комната останется с вами.</small>
              </div>
            </div>
          )}
          {favorites.isError && (
            <p className="form-error" role="status">
              Не удалось загрузить избранное.{' '}
              <button className="text-button" onClick={() => void favorites.refetch()}>
                Повторить
              </button>
            </p>
          )}
        </section>
        <footer className="home-footer">
          <ShieldCheck size={16} />
          <span>До 10 участников · Два экрана одновременно · Временные файлы</span>
        </footer>
        {capabilities.isError && (
          <p className="service-note" role="status">
            Сервер сейчас недоступен. Можно настроить устройства; для входа понадобится соединение.
          </p>
        )}
      </main>
      <span className="build-label">CORD / 01</span>
    </div>
  );
}
