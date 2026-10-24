import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import {
  ChevronLeft,
  ChevronRight,
  Info,
  Keyboard,
  Mic,
  MonitorCog,
  Palette,
  Plug,
  Search,
  Server,
  User,
  Video,
  Volume2,
  X,
  type LucideProps,
} from 'lucide-react';
import type { Meeting } from '../../core/meeting';
import { useTranslation } from 'react-i18next';
import { hasFeature, isDesktop } from '../../core/desktop';
import { readPreferences, savePreferences, type Preferences } from '../../core/preferences';
import { Store } from '../../core/store';
import { SHEET } from '../breakpoints';
import { Avatar, useMediaQuery, useStore, type Theme } from '../primitives';
import { IconButton } from '../kit';
import { SettingsTargetContext, type SettingsTarget } from './Row';
import {
  anchorDomId,
  anchorTitle,
  GROUPS,
  groupTitle,
  placeFor,
  rowDomId,
  searchSettings,
  section as sectionSpec,
  sectionAvailable,
  sectionsFor,
  sectionTitle,
  DEFAULT_SECTION,
  type Place,
  type SearchHit,
  type SectionId,
} from './sections';
import { activeAnchor, watchScroll } from './scroll-spy';
import { AudioSection } from './AudioSection';
import { VideoSection } from './VideoSection';
import { SoundsSection } from './SoundsSection';
import { ProfileSection } from './ProfileSection';
import { AppearanceSection } from './AppearanceSection';
import { HotkeysSection } from './HotkeysSection';
import { AccountsSection } from './AccountsSection';
import { ServerSection } from './ServerSection';
import { AboutSection } from './AboutSection';
import { replayOnboarding } from '../../core/onboarding';
import { closeHelp } from '../support/help';
import { DesktopSection } from './DesktopSection';
import './settings.css';

const ICONS: Record<SectionId, ComponentType<LucideProps>> = {
  profile: User,
  appearance: Palette,
  hotkeys: Keyboard,
  desktop: MonitorCog,
  audio: Mic,
  video: Video,
  sounds: Volume2,
  accounts: Plug,
  server: Server,
  about: Info,
};

/** Раздел, которого здесь нет («Windows» в браузере или в оболочке без него), — раздел по умолчанию. */
function reachable(place: Place): Place {
  const context = isDesktop() ? 'desktop' : 'browser';
  return sectionAvailable(place.section, context, hasFeature) ? place : { section: DEFAULT_SECTION };
}

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
  /** Раздел, с которого открыться: `audio`, `about`, `video#camera` или прежнее имя вкладки. */
  section?: string;
  theme?: Theme;
  setTheme?: (theme: Theme) => void;
}) {
  const { t } = useTranslation();
  const saved = useMemo(() => new Store(readPreferences()), []);
  const preferences = useStore(meeting?.media.preferences ?? saved);
  const phone = useMediaQuery(SHEET);
  const [place, setPlace] = useState<Place>(() => reachable(placeFor(section)));
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
  // Заголовок раздела в верхней полосе: начальный фокус окна (R11) и запасной фокус после поиска.
  const title = useRef<HTMLHeadingElement>(null);
  const context = isDesktop() ? 'desktop' : 'browser';

  const go = (next: Place, row?: SearchHit['row'], focus = false) => {
    focusAfter.current = focus;
    setPlace(next);
    setView('section');
    setTarget((previous) => ({ anchor: next.anchor, row, nonce: previous.nonce + 1 }));
  };
  useEffect(() => {
    if (!open) return;
    // Одно окно за раз (S5): настройки, открытые оболочкой поверх помощи, её заменяют.
    closeHelp();
    if (!meeting) saved.set(readPreferences());
    const next = reachable(placeFor(section));
    setPlace(next);
    setView(section ? 'section' : 'list');
    setQuery('');
    setTarget((previous) => ({ anchor: next.anchor, nonce: previous.nonce + 1 }));
  }, [open, section, meeting, saved]);

  // Какой подраздел сейчас на экране — его якорь слева подсвечен (R12, R115, `scroll-spy.ts`).
  const anchors = sectionSpec(place.section).anchors;
  const spyWatch = useRef<ReturnType<typeof watchScroll> | null>(null);
  // Раньше перехода ниже: его программная прокрутка уже должна попасть под паузу.
  useLayoutEffect(() => {
    if (!scroller || !anchors.length) return;
    const watch = watchScroll(scroller, () => {
      const edge = scroller.getBoundingClientRect().top;
      const tops = anchors.flatMap((anchor) => {
        const element = document.getElementById(anchorDomId(anchor));
        return element ? [{ anchor, top: element.getBoundingClientRect().top - edge }] : [];
      });
      // Всё помещается — остаётся выбранный щелчком (R115): правилу нужен подсвеченный сейчас.
      setSpy(
        (current) =>
          activeAnchor({
            scrollTop: scroller.scrollTop,
            clientHeight: scroller.clientHeight,
            scrollHeight: scroller.scrollHeight,
            tops,
            current,
          }) ?? current,
      );
    });
    spyWatch.current = watch;
    return () => {
      watch.stop();
      spyWatch.current = null;
    };
  }, [anchors, view, scroller]);

  // Переход: к строке, к подразделу или в начало раздела — после того, как раздел нарисован.
  useLayoutEffect(() => {
    if (!scroller || !target.nonce) return;
    const anchor = target.anchor ? document.getElementById(anchorDomId(target.anchor)) : null;
    const row = target.row ? document.getElementById(rowDomId(target.row)) : null;
    // Строка, которой не видно (её нет в этом месте или она в скрытом теле), — к подразделу.
    const goal = row && row.getClientRects().length ? row : anchor;
    // Прокрутку ставит программа: подсветка не пересчитывается, пока она не закончится, — иначе
    // щелчок по короткой нижней группе подсветил бы соседнюю (R12).
    spyWatch.current?.hold();
    if (goal) {
      const top =
        goal.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, top - 16);
    } else scroller.scrollTop = 0;
    setSpy(target.anchor ?? sectionSpec(place.section).anchors[0]);
    if (focusAfter.current) {
      focusAfter.current = false;
      // Фокус — на управление найденной строки; не вышло (строки здесь нет) — на заголовок раздела.
      const control = (row ?? goal)?.querySelector<HTMLElement>(
        'input, select, button, [role="switch"], [tabindex]',
      );
      control?.focus({ preventScroll: true });
      if (!control || document.activeElement !== control) title.current?.focus({ preventScroll: true });
    }
  }, [target, place.section, view, scroller]);

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

  /*
    Начальный фокус (R11, S1): открыли мышью — на заголовок раздела (`tabIndex=-1`, кольца у него
    не бывает), и карточка профиля, первая в Tab-порядке, не обводится от первого же Shift. С
    клавиатуры — как обычно, первый элемент, и кольцо на нём на месте.
  */
  const initialFocus = (type: string) =>
    type === 'keyboard' || document.documentElement.dataset.input === 'keyboard' ? true : title.current;

  const titleId = useId();
  const close = (
    <Dialog.Close
      render={
        <IconButton label={t(($) => $.common.close)} className="settings-close">
          <X />
        </IconButton>
      }
    />
  );
  // Прокручен ли раздел — для волоска под верхней полосой.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!scroller) return;
    const update = () => setScrolled(scroller.scrollTop > 0);
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, [scroller, place.section, view]);

  const hits = query.trim() ? searchSettings(t, query, context, 8, hasFeature) : null;
  const searching = hits !== null;
  // Отрезок рейки подразделов едет к текущему подразделу (R12): положение — по его кнопке.
  const rail = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    const list = rail.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!list || !current) return;
    list.style.setProperty('--rail-y', `${current.offsetTop}px`);
    list.style.setProperty('--rail-h', `${current.offsetHeight}px`);
  }, [spy, place.section, searching]);

  const current = sectionSpec(place.section);
  const body = (() => {
    switch (place.section) {
      case 'audio':
        return <AudioSection preferences={preferences} change={change} meeting={meeting} />;
      case 'video':
        return <VideoSection preferences={preferences} change={change} meeting={meeting} />;
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
          <HotkeysSection
            value={preferences.micHotkey}
            overlay={preferences.overlayHotkey}
            change={(micHotkey) => void change({ micHotkey })}
            mode={preferences.micHotkeyMode}
            changeMode={(micHotkeyMode) => void change({ micHotkeyMode })}
          />
        );
      case 'desktop':
        return <DesktopSection preferences={preferences} change={change} />;
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
        return (
          <AboutSection
            onTour={() => {
              // «Пройти знакомство» (T34): подсказки — снова, окно закрывается, чтобы их было видно.
              replayOnboarding();
              onOpenChange(false);
            }}
            // «Помощь и поддержка»: окно настроек закрывается, помощь открывается на его месте (S5).
            onHelp={() => onOpenChange(false)}
          />
        );
    }
  })();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="ui-dialog__backdrop settings-backdrop" />
        <Dialog.Viewport className="settings-viewport">
          <Dialog.Popup
            className="settings-window"
            data-view={phone ? view : undefined}
            initialFocus={initialFocus}
          >
            <nav className="settings-nav" aria-label={t(($) => $.settings.navigation)}>
              <div className="settings-nav__head">
                <Dialog.Title className="settings-nav__title">{t(($) => $.settings.title)}</Dialog.Title>
                {/* На телефоне список разделов — свой экран, и закрыть окно надо и с него. */}
                {phone && view === 'list' && close}
              </div>
              <button
                type="button"
                className="settings-profile"
                aria-current={place.section === 'profile' && !hits ? 'page' : undefined}
                onClick={() => go({ section: 'profile' })}
              >
                <Avatar
                  name={preferences.name || t(($) => $.settings.you)}
                  src={preferences.avatar || null}
                />
                <span className="settings-profile__text">
                  <span className="settings-profile__name">
                    {preferences.name.trim() || t(($) => $.settings.unnamed)}
                  </span>
                  <span className="settings-profile__hint">{t(($) => $.settings.device)}</span>
                </span>
                <ChevronRight size={16} aria-hidden="true" className="settings-profile__chevron" />
              </button>
              <label className="settings-search">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  className="settings-search__input"
                  placeholder={t(($) => $.settings.search)}
                  aria-label={t(($) => $.settings.search)}
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
                <div
                  className="settings-results"
                  role="region"
                  aria-label={t(($) => $.settings.found)}
                  aria-live="polite"
                >
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
                    <p className="settings-results__empty">{t(($) => $.settings.nothing)}</p>
                  )}
                </div>
              ) : (
                GROUPS.map((group) => (
                  <div key={group} className="settings-nav__group" data-group={group}>
                    {group !== 'cord' && (
                      <h3 className="settings-nav__group-title">{groupTitle(t, group)}</h3>
                    )}
                    <ul>
                      {sectionsFor(context, hasFeature)
                        .filter((spec) => spec.group === group)
                        .map((spec) => {
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
                                <span>{sectionTitle(t, spec.id)}</span>
                                <ChevronRight
                                  size={16}
                                  aria-hidden="true"
                                  className="settings-nav__chevron"
                                />
                              </button>
                              {active && !phone && spec.anchors.length > 0 && (
                                <ul
                                  ref={rail}
                                  className="settings-nav__anchors"
                                  aria-label={t(($) => $.settings.subsections, {
                                    section: sectionTitle(t, spec.id),
                                  })}
                                >
                                  {spec.anchors.map((anchor) => (
                                    <li key={anchor}>
                                      <button
                                        type="button"
                                        className="settings-nav__anchor"
                                        aria-current={spy === anchor ? 'location' : undefined}
                                        onClick={() => go({ section: spec.id, anchor })}
                                      >
                                        {anchorTitle(t, spec.id, anchor)}
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
            <section className="settings-pane" aria-labelledby={titleId}>
              {/*
                Верхняя полоса раздела (R15): заголовок слева, крестик справа — в одной строке и вне
                области прокрутки, поэтому центры совпадают конструкцией, а не подобранным отступом.
                Волосок под полосой появляется, когда раздел прокручен.
              */}
              <header className="settings-content__bar" data-scrolled={scrolled || undefined}>
                {phone && (
                  <IconButton
                    label={t(($) => $.settings.back)}
                    className="settings-content__back"
                    onClick={() => setView('list')}
                  >
                    <ChevronLeft />
                  </IconButton>
                )}
                <h2 className="settings-content__title" id={titleId} tabIndex={-1} ref={title}>
                  {sectionTitle(t, current.id)}
                </h2>
                {close}
              </header>
              <div className="settings-content" ref={setScroller}>
                <SettingsTargetContext.Provider value={target}>
                  <div
                    className="settings-content__body"
                    data-section={current.id}
                    data-layout={current.layout ?? 'cards'}
                  >
                    {body}
                  </div>
                </SettingsTargetContext.Provider>
              </div>
            </section>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
