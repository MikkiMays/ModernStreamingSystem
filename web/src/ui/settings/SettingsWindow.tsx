import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import {
  ChevronLeft,
  ChevronRight,
  Info,
  Keyboard,
  Mic,
  Palette,
  Plug,
  Search,
  Server,
  User,
  Volume2,
  X,
  type LucideProps,
} from 'lucide-react';
import type { Meeting } from '../../core/meeting';
import { readPreferences, savePreferences, type Preferences } from '../../core/preferences';
import { Store } from '../../core/store';
import { unknownLink } from '../../media/link-quality';
import { SHEET } from '../breakpoints';
import { Avatar, useMediaQuery, useStore, type Theme } from '../primitives';
import { IconButton } from '../kit';
import { SettingsTargetContext, type SettingsTarget } from './Row';
import {
  anchorDomId,
  GROUPS,
  placeFor,
  rowDomId,
  searchSettings,
  section as sectionSpec,
  SECTIONS,
  type Place,
  type SearchHit,
  type SectionId,
} from './sections';
import { VoiceSection } from './VoiceSection';
import { SoundsSection } from './SoundsSection';
import { ProfileSection } from './ProfileSection';
import { AppearanceSection } from './AppearanceSection';
import { HotkeysSection } from './HotkeysSection';
import { AccountsSection } from './AccountsSection';
import { ServerSection } from './ServerSection';
import { AboutSection } from './AboutSection';
import './settings.css';

const ICONS: Record<SectionId, ComponentType<LucideProps>> = {
  profile: User,
  appearance: Palette,
  hotkeys: Keyboard,
  voice: Mic,
  sounds: Volume2,
  accounts: Plug,
  server: Server,
  about: Info,
};

const TEXT = {
  title: 'Настройки',
  navigation: 'Разделы настроек',
  search: 'Найти настройку',
  nothing: 'Ничего не нашлось',
  device: 'Это устройство',
  unnamed: 'Без имени',
  back: 'К разделам',
  close: 'Закрыть',
};

/**
 * Окно настроек (T26): фиксированного размера на любой ширине стола — переключение раздела не
 * меняет ни ширину, ни высоту, прокручивается только правая часть. Слева, как у Discord, —
 * профиль устройства, поиск и разделы со значками в группах, у открытого раздела — подразделы
 * якорями; справа, как у FACEIT, — строки «подпись — действие» в сворачиваемых группах. На
 * телефоне — список разделов, а раздел открывается своим экраном с «назад».
 *
 * Настройки одни на всё приложение: главная, встреча и клиент Windows (мост `settings.open`
 * называет раздел — и прежними именами вкладок тоже, `placeFor`).
 */
export function SettingsWindow({
  meeting,
  open,
  onOpenChange,
  section,
  theme,
  setTheme,
}: {
  meeting?: Meeting;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Раздел, с которого открыться: `voice`, `about`, `voice#camera` или прежнее имя вкладки. */
  section?: string;
  theme?: Theme;
  setTheme?: (theme: Theme) => void;
}) {
  const saved = useMemo(() => new Store(readPreferences()), []);
  const offline = useMemo(() => new Store(unknownLink), []);
  const preferences = useStore(meeting?.media.preferences ?? saved);
  // Вне встречи о канале сказать нечего, но хук должен вызываться всегда.
  const link = useStore(meeting?.media.link ?? offline);
  const phone = useMediaQuery(SHEET);
  const [place, setPlace] = useState<Place>(() => placeFor(section));
  const [target, setTarget] = useState<SettingsTarget>({ nonce: 0 });
  // На телефоне видно что-то одно: список разделов или раздел. Попросили раздел — сразу он.
  const [view, setView] = useState<'list' | 'section'>(section ? 'section' : 'list');
  const [query, setQuery] = useState('');
  const [spy, setSpy] = useState<string | undefined>(undefined);
  // Правая часть — состоянием, а не ссылкой: окно рождается закрытым, и эффекты, которым она
  // нужна (прокрутка к месту, подсветка якоря), должны повториться, когда она появилась.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // Куда отдать фокус после перехода из поиска: нажатая строка результата исчезает.
  const focusAfter = useRef(false);
  const context = window.chrome?.webview ? 'desktop' : 'browser';

  const go = (next: Place, row?: SearchHit['row'], focus = false) => {
    focusAfter.current = focus;
    setPlace(next);
    setView('section');
    setTarget((previous) => ({ anchor: next.anchor, row, nonce: previous.nonce + 1 }));
  };
  useEffect(() => {
    if (!open) return;
    if (!meeting) saved.set(readPreferences());
    const next = placeFor(section);
    setPlace(next);
    setView(section ? 'section' : 'list');
    setQuery('');
    setTarget((previous) => ({ anchor: next.anchor, nonce: previous.nonce + 1 }));
  }, [open, section, meeting, saved]);

  // Переход: к строке, к подразделу или в начало раздела — после того, как раздел нарисован.
  useLayoutEffect(() => {
    if (!scroller || !target.nonce) return;
    const anchor = target.anchor ? document.getElementById(anchorDomId(target.anchor)) : null;
    const row = target.row ? document.getElementById(rowDomId(target.row)) : null;
    // Строка, которой не видно (её нет в этом месте или она в скрытом теле), — к подразделу.
    const goal = row && row.getClientRects().length ? row : anchor;
    if (goal) {
      const top =
        goal.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, top - 16);
    } else scroller.scrollTop = 0;
    setSpy(target.anchor ?? sectionSpec(place.section).anchors[0]?.id);
    if (focusAfter.current) {
      focusAfter.current = false;
      // Фокус — на управление найденной строки; не вышло (строки здесь нет) — на заголовок раздела.
      const control = (row ?? goal)?.querySelector<HTMLElement>(
        'input, select, button, [role="switch"], [tabindex]',
      );
      control?.focus({ preventScroll: true });
      if (!control || document.activeElement !== control)
        scroller.querySelector<HTMLElement>('.settings-content__title')?.focus({ preventScroll: true });
    }
  }, [target, place.section, view, scroller]);

  // Какой подраздел сейчас на экране — его якорь слева подсвечен.
  const anchors = sectionSpec(place.section).anchors;
  useEffect(() => {
    if (!scroller || !anchors.length) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const edge = scroller.getBoundingClientRect().top + 48;
      let current = anchors[0]?.id;
      for (const anchor of anchors) {
        const element = document.getElementById(anchorDomId(anchor.id));
        if (element && element.getBoundingClientRect().top <= edge) current = anchor.id;
      }
      setSpy(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [anchors, view, scroller]);

  /**
   * Сохранить настройку — и, если это картинка профиля, дождаться ответа комнаты.
   *
   * Обещание возвращается ради одного этого случая: всё остальное здесь местное и отказать не
   * может, а картинку комната проверяет и вправе не принять. Тот, кто её ставит, обязан узнать
   * об этом — молчаливый отказ и был жалобой «не могу поменять аватар».
   */
  const change = (patch: Partial<Preferences>): Promise<void> => {
    if (meeting) meeting.media.saveSettings(patch);
    else saved.set(savePreferences(patch));
    // Комната узнаёт картинку при входе, поэтому смену во время встречи надо отправить и ей,
    // иначе она появится только в следующий раз.
    if (meeting && patch.avatar !== undefined)
      return meeting.command('profile.avatar', patch.avatar).then(() => undefined);
    return Promise.resolve();
  };

  const hits = query.trim() ? searchSettings(query, context) : null;
  const current = sectionSpec(place.section);
  const body = (() => {
    switch (place.section) {
      case 'voice':
        return <VoiceSection preferences={preferences} change={change} meeting={meeting} link={link} />;
      case 'sounds':
        return <SoundsSection preferences={preferences} change={change} />;
      case 'profile':
        return <ProfileSection preferences={preferences} change={change} />;
      case 'appearance':
        return (
          <AppearanceSection theme={theme} setTheme={setTheme} preferences={preferences} change={change} />
        );
      case 'hotkeys':
        return (
          <HotkeysSection value={preferences.micHotkey} change={(micHotkey) => void change({ micHotkey })} />
        );
      case 'accounts':
        return <AccountsSection preferences={preferences} change={change} />;
      case 'server':
        return (
          <ServerSection
            showPing={preferences.showPing}
            changePing={(showPing) => void change({ showPing })}
            inCall={!!meeting && !meeting.ended.get()}
          />
        );
      case 'about':
        return <AboutSection />;
    }
  })();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog__backdrop" />
        <Dialog.Viewport className="settings-viewport">
          <Dialog.Popup className="settings-window" data-view={phone ? view : undefined}>
            <nav className="settings-nav" aria-label={TEXT.navigation}>
              <Dialog.Title className="settings-nav__title">{TEXT.title}</Dialog.Title>
              <button
                type="button"
                className="settings-profile"
                aria-current={place.section === 'profile' && !hits ? 'page' : undefined}
                onClick={() => go({ section: 'profile' })}
              >
                <Avatar name={preferences.name || 'Вы'} src={preferences.avatar || null} />
                <span className="settings-profile__text">
                  <span className="settings-profile__name">{preferences.name.trim() || TEXT.unnamed}</span>
                  <span className="settings-profile__hint">{TEXT.device}</span>
                </span>
                <ChevronRight size={16} aria-hidden="true" className="settings-profile__chevron" />
              </button>
              <label className="settings-search">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  className="settings-search__input"
                  placeholder={TEXT.search}
                  aria-label={TEXT.search}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(event) => {
                    // Esc в непустом поиске очищает его, а не закрывает окно.
                    if (event.key === 'Escape' && query) {
                      event.stopPropagation();
                      event.preventDefault();
                      setQuery('');
                    }
                  }}
                />
              </label>
              {hits ? (
                <div className="settings-results" role="region" aria-label="Найдено" aria-live="polite">
                  {hits.length ? (
                    <ul>
                      {hits.map((hit) => (
                        <li key={`${hit.section}-${hit.row ?? ''}`}>
                          <button
                            type="button"
                            className="settings-result"
                            onClick={() => {
                              go({ section: hit.section, anchor: hit.anchor }, hit.row, true);
                              setQuery('');
                            }}
                          >
                            <span className="settings-result__title">{hit.title}</span>
                            <span className="settings-result__where">{hit.where}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="settings-results__empty">{TEXT.nothing}</p>
                  )}
                </div>
              ) : (
                GROUPS.map((group) => (
                  <div key={group.id} className="settings-nav__group" data-group={group.id}>
                    {group.title && <h3 className="settings-nav__group-title">{group.title}</h3>}
                    <ul>
                      {SECTIONS.filter((spec) => spec.group === group.id).map((spec) => {
                        const Icon = ICONS[spec.id];
                        const active = spec.id === place.section;
                        return (
                          <li key={spec.id}>
                            <button
                              type="button"
                              className="settings-nav__item"
                              aria-current={active ? 'page' : undefined}
                              onClick={() => go({ section: spec.id })}
                            >
                              <Icon size={18} aria-hidden="true" />
                              <span>{spec.title}</span>
                              <ChevronRight size={16} aria-hidden="true" className="settings-nav__chevron" />
                            </button>
                            {active && !phone && spec.anchors.length > 0 && (
                              <ul className="settings-nav__anchors" aria-label={`Подразделы: ${spec.title}`}>
                                {spec.anchors.map((anchor) => (
                                  <li key={anchor.id}>
                                    <button
                                      type="button"
                                      className="settings-nav__anchor"
                                      aria-current={spy === anchor.id ? 'location' : undefined}
                                      onClick={() => go({ section: spec.id, anchor: anchor.id })}
                                    >
                                      {anchor.title}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))
              )}
            </nav>
            <div className="settings-content" ref={setScroller}>
              <header className="settings-content__head">
                {phone && (
                  <IconButton
                    label={TEXT.back}
                    className="settings-content__back"
                    onClick={() => setView('list')}
                  >
                    <ChevronLeft size={20} />
                  </IconButton>
                )}
                <h2 className="settings-content__title" tabIndex={-1}>
                  {current.title}
                </h2>
              </header>
              <SettingsTargetContext.Provider value={target}>
                <div className="settings-content__body" data-section={current.id}>
                  {body}
                </div>
              </SettingsTargetContext.Provider>
            </div>
            <Dialog.Close
              render={
                <IconButton label={TEXT.close} variant="solid" className="settings-close">
                  <X size={18} />
                </IconButton>
              }
            />
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
