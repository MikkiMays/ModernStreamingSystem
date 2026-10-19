import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { Menu as MenuIcon, Settings2, ShieldCheck, X } from 'lucide-react';
import { useState, type CSSProperties } from 'react';
import type { Admission } from '../../api/types';
import type { Destination } from '../../core/invitation';
import { HOME_NAV_DOCKED } from '../breakpoints';
import { HomeEntry } from '../HomeEntry';
import { InstallHint } from '../InstallHint';
import { IconButton, ResizeHandle, ToastProvider, usePanelWidth } from '../kit';
import { Logo } from '../brand/Logo';
import { DownloadLink, useMediaQuery } from '../primitives';
import { ActiveMeetingNotice, useActiveMeetings } from './ActiveMeetingNotice';
import { FavoritesNav } from './FavoritesNav';
import './home.css';

/** Строки главной — в одном месте, до слоя переводов (E14). */
const TEXT = {
  sidebar: 'Боковая панель',
  width: 'Ширина боковой панели',
  openMenu: 'Открыть меню',
  closeMenu: 'Закрыть меню',
  menu: 'Меню',
  settings: 'Настройки',
  privacy: 'Без аккаунта. На вашем сервере.',
  about: 'О программе',
};

/**
 * Главная в браузере (E02): слева боковая панель — марка, избранное с группами, настройки, — справа
 * вход во встречу. Ширину панели тянут ручкой, и она помнится на устройстве (T46, `home-sidebar`).
 * На узком экране панель уезжает под бургер: бургер и марка стоят на одной оси (T01).
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
  const docked = useMediaQuery(HOME_NAV_DOCKED);
  const width = usePanelWidth('home-sidebar', { min: 240, max: 400, default: 280 });
  const [drawer, setDrawer] = useState(false);
  const active = useActiveMeetings();
  const here = new Set(active.map((meeting) => meeting.roomId));
  const join = (destination: Destination) => {
    setDrawer(false);
    onJoin(destination);
  };
  const nav = (inDrawer: boolean) => (
    <>
      <div className="home-nav__head">
        <Logo />
        {inDrawer && (
          <BaseDialog.Close
            render={
              <IconButton label={TEXT.closeMenu}>
                <X size={18} />
              </IconButton>
            }
          />
        )}
      </div>
      <div className="home-nav__scroll">
        <FavoritesNav onJoin={join} here={here} />
      </div>
      <div className="home-nav__foot">
        <button
          type="button"
          className="home-nav__link"
          onClick={() => {
            setDrawer(false);
            onSettings();
          }}
        >
          <Settings2 size={18} aria-hidden="true" />
          {TEXT.settings}
        </button>
        <DownloadLink className="home-nav__link" />
      </div>
    </>
  );
  return (
    <ToastProvider>
      <div className="home-shell" style={{ '--home-nav-width': `${width.width}px` } as CSSProperties}>
        {docked ? (
          <>
            <aside className="home-nav" aria-label={TEXT.sidebar}>
              {nav(false)}
            </aside>
            <ResizeHandle
              className="home-nav__handle"
              edge="start"
              label={TEXT.width}
              value={width.width}
              min={width.min}
              max={width.max}
              onChange={width.setWidth}
              onReset={width.reset}
            />
          </>
        ) : (
          <>
            <header className="home-bar">
              <IconButton label={TEXT.openMenu} aria-expanded={drawer} onClick={() => setDrawer(true)}>
                <MenuIcon size={20} />
              </IconButton>
              <Logo />
            </header>
            <BaseDialog.Root open={drawer} onOpenChange={setDrawer}>
              <BaseDialog.Portal>
                <BaseDialog.Backdrop className="home-drawer__backdrop" />
                <BaseDialog.Popup className="home-nav home-drawer" aria-label={TEXT.menu}>
                  {nav(true)}
                </BaseDialog.Popup>
              </BaseDialog.Portal>
            </BaseDialog.Root>
          </>
        )}
        <div className="home-stage">
          <main className="home-stage__main">
            {active[0] && <ActiveMeetingNotice meeting={active[0]} onResume={onResume} />}
            <HomeEntry onCreate={onCreate} onJoin={join} />
          </main>
          <footer className="home-stage__foot">
            <span className="home-privacy">
              <ShieldCheck size={14} aria-hidden="true" /> {TEXT.privacy}
            </span>
            {/* Номера версии здесь нет (T58): он только в «О программе», куда эта ссылка и ведёт. */}
            <button type="button" className="home-about" onClick={() => onSettings('about')}>
              {TEXT.about}
            </button>
          </footer>
        </div>
        <InstallHint />
      </div>
    </ToastProvider>
  );
}
