import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Menu as MenuIcon, PanelLeft, Settings2, ShieldCheck, Star, X } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { Admission } from '../../api/types';
import type { Destination } from '../../core/invitation';
import { HOME_NAV_DOCKED } from '../breakpoints';
import { HomeEntry } from '../HomeEntry';
import { RecentMeetings } from './RecentMeetings';
import { InstallHint } from '../InstallHint';
import { IconButton, ResizeHandle, ToastProvider, usePanelCollapsed, usePanelWidth } from '../kit';
import { Logo } from '../brand/Logo';
import { isDesktop } from '../../core/desktop';
import { DownloadLink, useMediaQuery } from '../primitives';
import { ActiveMeetingNotice, useActiveMeetings } from './ActiveMeetingNotice';
import { FavoritesNav } from './FavoritesNav';
import { HelpButton } from '../support/HelpButton';
import { Ping } from '../Ping';
import './home.css';

/**
 * Главная в браузере (E02): слева боковая панель — марка, избранное с группами, настройки, — справа
 * вход во встречу. Ширину панели тянут ручкой, и она помнится на устройстве (T46, `home-sidebar`).
 * На узком экране панель уезжает под бургер: бургер и марка стоят на одной оси (T01).
 *
 * Панель сворачивается значком в её шапке, как в ChatGPT и Claude (R130): свёрнутая — узкая полоса
 * со значками (та же кнопка, «Избранное», настройки, поддержка, «Скачать»); выбор помнит устройство.
 *
 * Клиент Windows показывает избранное своей панелью, поэтому там эта главная не рисуется
 * (`DesktopHome`).
 */
export function HomeShell({
  onCreate,
  onJoin,
  onSettings,
  onResume,
}: {
  onCreate: () => void;
  onJoin: (destination: Destination) => void;
  onSettings: (section?: string) => void;
  /** Вернуться во встречу из соседней вкладки (T52). */
  onResume: (admission: Admission) => void;
}) {
  const { t } = useTranslation();
  const docked = useMediaQuery(HOME_NAV_DOCKED);
  const width = usePanelWidth('home-sidebar', { min: 240, max: 400, default: 280 });
  const { collapsed: folded, setCollapsed } = usePanelCollapsed('home-sidebar');
  /** Свёрнута — только у панели сбоку; выдвижная под бургером всегда целиком. */
  const collapsed = docked && folded;
  const [drawer, setDrawer] = useState(false);
  const active = useActiveMeetings();
  const here = new Set(active.map((meeting) => meeting.roomId));
  const join = (destination: Destination) => {
    setDrawer(false);
    onJoin(destination);
  };
  const toggle = (
    <IconButton
      label={collapsed ? t(($) => $.home.shell.expand) : t(($) => $.home.shell.collapse)}
      aria-expanded={!collapsed}
      className="home-nav__toggle"
      onClick={() => setCollapsed(!collapsed)}
    >
      <PanelLeft size={20} />
    </IconButton>
  );
  const nav = (inDrawer: boolean) => (
    <>
      <div className="home-nav__head">
        {!collapsed && <Logo />}
        {!inDrawer && toggle}
        {inDrawer && (
          <BaseDialog.Close
            render={
              <IconButton label={t(($) => $.home.shell.closeMenu)}>
                <X size={20} />
              </IconButton>
            }
          />
        )}
      </div>
      <div className="home-nav__scroll">
        {collapsed ? (
          // Свёрнутой панели нечем показать комнаты — «Избранное» разворачивает её обратно.
          <button
            type="button"
            className="home-nav__link"
            title={t(($) => $.favorites.nav.title)}
            onClick={() => setCollapsed(false)}
          >
            <Star size={20} aria-hidden="true" />
            <span className="home-nav__text">{t(($) => $.favorites.nav.title)}</span>
          </button>
        ) : (
          <FavoritesNav onJoin={join} here={here} />
        )}
      </div>
      <div className="home-nav__foot">
        <button
          type="button"
          className="home-nav__link"
          data-tour="settings"
          title={collapsed ? t(($) => $.home.shell.settings) : undefined}
          onClick={() => {
            setDrawer(false);
            onSettings();
          }}
        >
          <Settings2 size={20} aria-hidden="true" />
          <span className="home-nav__text">{t(($) => $.home.shell.settings)}</span>
        </button>
        {/* «Помощь» — рядом с настройками, как «?» в шапке Discord (T36); выдвижную панель, как и
            «Настройки», сначала закрывает — помощь не ложится поверх неё (S5). */}
        <HelpButton look="nav" tour="help" onOpen={() => setDrawer(false)} />
        <DownloadLink className="home-nav__link" />
      </div>
    </>
  );
  return (
    <ToastProvider>
      <div
        className="home-shell"
        data-nav={collapsed ? 'collapsed' : undefined}
        style={{ '--home-nav-width': `${width.width}px` } as CSSProperties}
      >
        {docked ? (
          <>
            <aside className="home-nav" aria-label={t(($) => $.home.shell.sidebar)}>
              {nav(false)}
            </aside>
            {!collapsed && (
              <ResizeHandle
                className="home-nav__handle"
                edge="start"
                label={t(($) => $.home.shell.width)}
                value={width.width}
                min={width.min}
                max={width.max}
                onChange={width.setWidth}
                onReset={width.reset}
              />
            )}
          </>
        ) : (
          <>
            <header className="home-bar">
              <IconButton
                label={t(($) => $.home.shell.openMenu)}
                aria-expanded={drawer}
                data-tour="menu"
                onClick={() => setDrawer(true)}
              >
                <MenuIcon size={20} />
              </IconButton>
              <Logo />
              <HelpButton className="home-bar__help" />
            </header>
            <BaseDialog.Root open={drawer} onOpenChange={setDrawer}>
              <BaseDialog.Portal>
                <BaseDialog.Backdrop className="home-drawer__backdrop" />
                <BaseDialog.Popup className="home-nav home-drawer" aria-label={t(($) => $.home.shell.menu)}>
                  {nav(true)}
                </BaseDialog.Popup>
              </BaseDialog.Portal>
            </BaseDialog.Root>
          </>
        )}
        <div className="home-stage">
          {/* Клиент Windows: окно тащат за верхнюю полосу главной, как за шапку встречи (R130). */}
          {isDesktop() && <div className="home-stage__drag" aria-hidden="true" />}
          <main className="home-stage__main">
            {active[0] && <ActiveMeetingNotice meeting={active[0]} onResume={onResume} />}
            <HomeEntry onCreate={onCreate} onJoin={join} />
            {/* Недавние (R148) — под входом; пустой список блока не рисует. */}
            <RecentMeetings onCreate={onCreate} onJoin={join} />
          </main>
          <footer className="home-stage__foot">
            <span className="home-privacy">
              <ShieldCheck size={12} aria-hidden="true" /> {t(($) => $.home.shell.privacy)}
            </span>
            {/* PING — тихим текстом в подвале, а не плашкой поверх марки (R20). */}
            <Ping />
            {/* Номера версии здесь нет (T58): он только в «О программе», куда эта ссылка и ведёт. */}
            <button type="button" className="home-about" onClick={() => onSettings('about')}>
              {t(($) => $.home.shell.about)}
            </button>
          </footer>
        </div>
        <InstallHint />
      </div>
    </ToastProvider>
  );
}
