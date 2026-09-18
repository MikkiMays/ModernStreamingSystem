import {
  ArrowDownLeft,
  ArrowRight,
  Link,
  Plus,
  Video,
  Star,
  ServerCog,
  ShieldCheck,
  Settings2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { publicApi } from '../api/client';
import { DownloadLink, IconButton, Logo, ThemeButton, type Theme } from './primitives';
import { favoriteApi } from '../core/favorites';
import { useFavorites } from './useFavorites';
import { InstallHint } from './InstallHint';
import { appLabel } from '../core/version';
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
          <IconButton label="Настройки" onClick={() => onSettings()}>
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
              {/* Перенос убирается на узком экране, поэтому пробел ставится отдельно:
                  без него две фразы слипались в «приглашение.Без аккаунта». */}
              <br /> Без аккаунта и лишних шагов.
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
            {/* Раньше здесь стояло «по коду организатор подтвердит ваш вход» — и так оно и
                работало, вопреки настройке комнаты. Теперь решает комната, и обещать за неё
                нельзя ни того, ни другого. */}
            <small className="join-code-hint">
              Правильный код открывает комнату сразу — если её хозяин не попросил подтверждать вход.
            </small>
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
            {/* Счётчик «N / 5» ушёл вместе с самим ограничением: сервер ваш, и сколько на нём
                комнат — не вопрос приложения. */}
            {!!favorites.data?.length && <span>{favorites.data.length}</span>}
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
        {/*
          ЗАЧЕМ ЭТОТ БЛОК. Главная отвечает на «как войти» — это первое, зачем сюда приходят,
          и оно остаётся сверху. Но приходят по чужой ссылке, и вопрос «а это чей вообще
          Cord?» возникает следом. Ответ на него — не список возможностей, а одна мысль:
          сервис, на который записываются, и программа, которую ставят себе, — разные вещи,
          и Cord вторая. Поэтому здесь нет ни кнопки, ни формы: это не призыв, а разворот.
        */}
        <section className="own-server">
          <span className="own-server-eyebrow">
            <ServerCog size={15} /> ЭТО МОЖНО ПОСТАВИТЬ СЕБЕ
          </span>
          <h2>Свой сервер. Свои люди. Свой Cord.</h2>
          <p>
            Cord не живёт в облаке — он живёт там, куда вы его поставили. Одна машина, одна команда{' '}
            <code>./setup.sh</code> — и адрес встреч ваш: ваши комнаты, ваши файлы, ваши голоса. Без
            аккаунтов, без чужих правил и без чужих ограничений.
          </p>
          <p className="own-server-note">
            Эта страница уже работает на чьём-то сервере. Следующая может работать на вашем.
          </p>
        </section>
        <footer className="home-footer">
          <ShieldCheck size={16} />
          <span>Разговор целиком на этом сервере · Временные файлы · Без аккаунтов</span>
        </footer>
        {capabilities.isError && (
          <p className="service-note" role="status">
            Сервер сейчас недоступен. Можно настроить устройства; для входа понадобится соединение.
          </p>
        )}
      </main>
      <InstallHint />
      {/*
        Здесь стояло «CORD / 01» — надпись, похожая на версию и не бывшая ею. Теперь это
        настоящая версия сборки, и по ней можно нажать: вопрос «какая у меня версия» почти
        всегда следующим шагом становится «а есть ли новее».
      */}
      <button className="build-label" onClick={() => onSettings('about')}>
        Cord {appLabel}
      </button>
    </div>
  );
}
