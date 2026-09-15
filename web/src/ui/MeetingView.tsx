import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  Activity,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Headphones,
  Link,
  MessageSquare,
  Music2,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Settings2,
  ShieldCheck,
  Users,
  Video,
  VideoOff,
  Wifi,
  X,
  Star,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import type { Meeting } from '../core/meeting';
import { IconButton, Logo, useStore } from './primitives';
import { Stage, AudioLayer } from './Stage';
import { Ping } from './Ping';
import { CameraMenu } from './CameraMenu';
import { Sidebar, type Panel } from './Sidebar';
import { Invite } from './Invite';
import { Settings } from './Settings';
import { ThemeButton, formatCode, type Theme } from './Home';
import { favoriteApi } from '../core/favorites';
import { useFavorites } from './useFavorites';
import { isTyping, matchesHotkey } from '../core/hotkeys';
import { notifyDesktop, onDesktopCommand } from '../core/desktop';

const Diagnostics = lazy(() => import('./Diagnostics'));
export function MeetingView({
  meeting,
  onHome,
  theme,
  setTheme,
}: {
  meeting: Meeting;
  onHome: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
}) {
  const snapshot = useStore(meeting.snapshot);
  const viewing = useStore(meeting.viewing);
  const pinned = useStore(meeting.pinnedCamera);
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const lastActivity = useRef(Date.now());
  const collapseToggle = useRef<HTMLButtonElement>(null);
  const wakeControls = () => {
    lastActivity.current = Date.now();
    if (!controlsCollapsed) setControlsVisible(true);
  };
  useEffect(() => {
    const changed = () => {
      setFullscreen(!!document.fullscreenElement);
      setControlsVisible(true);
      setControlsCollapsed(false);
      lastActivity.current = Date.now();
    };
    document.addEventListener('fullscreenchange', changed);
    return () => {
      document.removeEventListener('fullscreenchange', changed);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!fullscreen || controlsCollapsed) return;
    const timer = setInterval(() => {
      const held = [
        ...document.querySelectorAll<HTMLElement>(
          '[role="menu"], [role="dialog"], .call-footer :focus-visible',
        ),
      ].some((element) => element.checkVisibility() && !element.closest('[aria-hidden="true"]'));
      setControlsVisible(held || Date.now() - lastActivity.current < 3000);
    }, 200);
    return () => clearInterval(timer);
  }, [fullscreen, controlsCollapsed]);
  const media = useStore(meeting.media.state);
  const tracks = useStore(meeting.media.tracks);
  const control = useStore(meeting.control.state);
  const ended = useStore(meeting.ended);
  useEffect(() => {
    notifyDesktop('call-state', { inCall: !ended });
  }, [ended]);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [invite, setInvite] = useState(false);
  const [settings, setSettings] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const preferences = useStore(meeting.media.preferences);
  const favorites = useFavorites();
  const volumes = useStore(meeting.media.volumes);
  const deafened = useStore(meeting.media.deafened);
  const isFavorite = !!favorites.data?.some((f) => f.roomId === meeting.admission.roomId);
  const [savingFavorite, setSavingFavorite] = useState(false);
  const profile = preferences.screen;
  const [width, setWidth] = useState(360);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const audioNeedsGesture = useCallback(() => setAudioBlocked(true), []);
  const showIntegrationPanel = preferences.showIntegrationPanel !== false;
  useEffect(() => {
    meeting.start();
    return () => meeting.dispose();
  }, [meeting]);
  useEffect(() => {
    const toggle = () => {
      if (!meeting.ended.get() && meeting.media.state.get().status === 'connected')
        void meeting.media.toggle('microphone');
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.repeat || isTyping(event.target) || document.querySelector('[role="dialog"]')) return;
      if (matchesHotkey(event, preferences.micHotkey)) {
        event.preventDefault();
        toggle();
      }
    };
    notifyDesktop('hotkey.configure', { hotkey: ended ? null : preferences.micHotkey });
    window.addEventListener('keydown', keyboard);
    const unsubscribe = onDesktopCommand((command) => {
      if (command.type === 'microphone.toggle') toggle();
    });
    return () => {
      window.removeEventListener('keydown', keyboard);
      unsubscribe();
      notifyDesktop('hotkey.configure', { hotkey: null });
    };
  }, [meeting, preferences.micHotkey, ended]);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  const togglePanel = (value: Panel) => setPanel((p) => (p === value ? null : value));
  const openServicesPanel = () => setPanel((current) => (current === 'services' ? null : 'services'));
  const setPanelWidth = (value: number) => setWidth(Math.min(480, Math.max(320, value)));
  return (
    <div
      className={`meeting-page ${fullscreen ? 'meeting-fullscreen' : ''} ${controlsVisible ? '' : 'controls-hidden'}`}
      onPointerMove={wakeControls}
      onPointerDown={wakeControls}
      onFocusCapture={wakeControls}
      style={{ '--panel-width': `${width}px` } as CSSProperties}
    >
      <Ping meeting={meeting} />
      <header className="meeting-header">
        <div className="meeting-title">
          <Logo />
          <span className="header-divider" />
          <div>
            <h1>{snapshot.title}</h1>
            <span className="room-subtitle">
              <ShieldCheck size={12} />{' '}
              <button className="room-code" aria-label="Код встречи" onClick={() => setInvite(true)}>
                {snapshot.code ? formatCode(snapshot.code) : 'Пригласить'}
              </button>
            </span>
          </div>
        </div>
        <div className="meeting-header-actions">
          <span className={`connection-badge ${media.status === 'connected' ? 'is-live' : ''}`}>
            <span className="status-dot" />
            {ended
              ? 'Завершено'
              : media.status === 'connected'
                ? 'В эфире'
                : self?.status === 'WAITING'
                  ? 'Ожидание входа'
                  : 'Подключаемся'}
          </span>
          <ThemeButton theme={theme} setTheme={setTheme} />
          <IconButton
            label={isFavorite ? 'Убрать комнату из избранного' : 'Сохранить комнату в избранное'}
            aria-pressed={isFavorite}
            className={isFavorite ? 'favorite-active' : ''}
            disabled={savingFavorite || !self || self.status === 'WAITING'}
            onClick={async () => {
              setSavingFavorite(true);
              try {
                if (isFavorite) await favoriteApi.remove(meeting.admission.roomId);
                else await favoriteApi.save(meeting.admission);
                await favorites.refetch();
              } catch (e) {
                meeting.media.report(e);
              } finally {
                setSavingFavorite(false);
              }
            }}
          >
            <Star size={20} fill={isFavorite ? 'currentColor' : 'none'} />
          </IconButton>
          <IconButton label="Пригласить участников" onClick={() => setInvite(true)}>
            <Link size={19} />
          </IconButton>
        </div>
      </header>
      <div className={`meeting-body ${panel ? 'panel-open' : ''}`}>
        <main className="stage-wrap" aria-label="Сцена встречи">
          {!ended && self?.owner && snapshot.participants.some((p) => p.status === 'WAITING') && (
            <button className="admission-banner" onClick={() => setPanel('people')}>
              <Users size={18} /> Запросы на подключение:{' '}
              {snapshot.participants.filter((p) => p.status === 'WAITING').length} · Открыть
            </button>
          )}
          {!ended && media.status === 'recovering' && (
            <div className="recovery-banner" role="status">
              <Wifi size={20} />
              <div>
                <strong>Возвращаемся в разговор</strong>
                <span>Проверьте сеть. Повторяем подключение автоматически.</span>
              </div>
              <b>{media.remaining} с</b>
            </div>
          )}
          {!ended && control === 'recovering' && media.status === 'connected' && (
            <div className="control-banner" role="status">
              Восстанавливаем чат и управление. Аудио и видео продолжают работать.
            </div>
          )}
          {!ended && media.liveStatus && control !== 'recovering' && media.status === 'connected' && (
            <div className="control-banner" role="status">
              {media.liveStatus}
            </div>
          )}
          {ended ? (
            <div className="ended-stage">
              <span className="ended-icon">
                <PhoneOff size={28} />
              </span>
              <h2>{ended}</h2>
              <p>
                Спасибо за разговор.
                <br />
                Сообщения и файлы доступны до окончания срока хранения.
              </p>
              <button className="button primary" onClick={onHome}>
                <ArrowLeft size={18} /> На главную
              </button>
              <button className="button stage-ghost" onClick={() => setPanel('chat')}>
                Открыть историю
              </button>
            </div>
          ) : self?.status === 'WAITING' ? (
            <div className="ended-stage">
              <span className="waiting-orbit">
                <Users size={32} />
              </span>
              <h2>Организатор скоро впустит вас</h2>
              <p>
                Можно спокойно устроиться.
                <br />
                Звук и камера пока не передаются.
              </p>
            </div>
          ) : (
            <>
              <Stage
                meeting={meeting}
                onOpenServices={openServicesPanel}
                showServices={showIntegrationPanel}
              />
              {(viewing || pinned) && (
                <button className="return-conversation" onClick={() => meeting.returnToConversation()}>
                  <ArrowLeft size={16} /> Вернуться в разговор
                </button>
              )}
              {snapshot.participants.length === 1 && !media.screen && (
                <button className="invite-hint" onClick={() => setInvite(true)}>
                  <Users size={18} />
                  <span>Самое время пригласить своих</span>
                  <Link size={16} />
                </button>
              )}
            </>
          )}
          {audioBlocked && (
            <button
              className="audio-unlock button primary"
              onClick={() => void meeting.media.room.startAudio().then(() => setAudioBlocked(false))}
            >
              <Headphones size={18} /> Включить звук встречи
            </button>
          )}
          {media.error && !ended && (
            <div className="media-error" role="alert">
              <span>{media.error}</span>
              <IconButton label="Скрыть уведомление" onClick={() => meeting.media.clearError()}>
                <X size={18} />
              </IconButton>
            </div>
          )}
          {fullscreen && (
            <button
              ref={collapseToggle}
              className="controls-toggle"
              aria-label={controlsVisible ? 'Свернуть управление' : 'Развернуть управление'}
              aria-expanded={controlsVisible}
              aria-controls="meeting-controls"
              onClick={() => {
                const collapse = controlsVisible;
                setControlsCollapsed(collapse);
                setControlsVisible(!collapse);
                lastActivity.current = Date.now();
                collapseToggle.current?.focus({ preventScroll: true });
              }}
            >
              {controlsVisible ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
              {!controlsVisible && <span>Управление</span>}
            </button>
          )}
          <footer id="meeting-controls" className="call-footer">
            <div className="call-footer-info">
              <Wifi size={16} />
              <span>
                {media.status === 'connected'
                  ? 'Связь установлена'
                  : ended
                    ? 'До новой встречи'
                    : 'Устанавливаем связь'}
              </span>
              <button onClick={() => setDiagnostics(true)} className="quality-tag">
                {media.screen ? `${profile.resolution}p · ${profile.fps}` : 'HD'}
              </button>
            </div>
            <div className="call-dock" aria-label="Управление встречей">
              <IconButton
                label={media.microphone ? 'Выключить микрофон' : 'Включить микрофон'}
                className={media.microphone ? 'dock-on' : 'dock-off'}
                disabled={!!ended || media.status !== 'connected'}
                aria-pressed={media.microphone}
                onClick={() => void meeting.media.toggle('microphone')}
              >
                {media.microphone ? <Mic size={22} /> : <MicOff size={22} />}
              </IconButton>
              <IconButton
                label={media.camera ? 'Выключить камеру' : 'Включить камеру'}
                className={media.camera ? 'dock-on' : 'dock-off'}
                disabled={!!ended || media.status !== 'connected'}
                aria-pressed={media.camera}
                onClick={() => void meeting.media.toggle('camera')}
              >
                {media.camera ? <Video size={22} /> : <VideoOff size={22} />}
              </IconButton>
              <CameraMenu meeting={meeting} />
              <span className="dock-divider" />
              <button
                className={`share-button ${media.screen ? 'is-sharing' : ''}`}
                disabled={!!ended || media.status !== 'connected'}
                onClick={() => meeting.media.share(profile)}
                aria-pressed={media.screen}
              >
                <MonitorUp size={21} />
                <span>{media.screen ? 'Остановить' : 'Показать экран'}</span>
              </button>
              <Menu.Root>
                <Menu.Trigger
                  render={
                    <IconButton label="Настройки и действия" className="dock-more">
                      <ChevronDown size={20} />
                    </IconButton>
                  }
                />
                <Menu.Portal>
                  <Menu.Positioner side="top" sideOffset={12}>
                    <Menu.Popup className="action-menu">
                      <Menu.Item onClick={() => openServicesPanel()}>
                        <Music2 size={18} /> Интеграции
                      </Menu.Item>
                      <Menu.Item onClick={() => setSettings(true)}>
                        <Settings2 size={18} /> Настройки
                      </Menu.Item>
                      <Menu.Item onClick={() => setDiagnostics(true)}>
                        <Activity size={18} /> Диагностика
                      </Menu.Item>
                      <Menu.Item onClick={() => meeting.media.deafened.set(!deafened)}>
                        <Headphones size={18} />{' '}
                        {deafened ? 'Включить звук встречи' : 'Выключить звук у себя'}
                      </Menu.Item>
                      {self?.owner && (
                        <Menu.Item
                          className="danger-text"
                          onClick={() => void meeting.command('close').catch((e) => meeting.media.report(e))}
                        >
                          <PhoneOff size={18} /> Завершить для всех
                        </Menu.Item>
                      )}
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.Root>
              <IconButton
                label={fullscreen ? 'Выйти из полноэкранного режима' : 'Полноэкранный режим'}
                onClick={() => {
                  if (document.fullscreenElement) void document.exitFullscreen();
                  else
                    void document.documentElement.requestFullscreen().catch((e) => meeting.media.report(e));
                }}
              >
                {fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
              </IconButton>
              <IconButton
                label="Выйти из встречи"
                className="hangup"
                disabled={!!ended}
                onClick={() => {
                  void meeting.leave();
                  onHome();
                }}
              >
                <PhoneOff size={22} />
              </IconButton>
            </div>
            <div className="panel-controls">
              <IconButton
                label="Участники"
                aria-pressed={panel === 'people'}
                className={panel === 'people' ? 'selected' : ''}
                onClick={() => togglePanel('people')}
              >
                <Users size={21} />
                <span className="count-badge">{snapshot.participants.filter((p) => !p.service).length}</span>
              </IconButton>
              <IconButton
                label="Чат"
                aria-pressed={panel === 'chat'}
                className={panel === 'chat' ? 'selected' : ''}
                onClick={() => togglePanel('chat')}
              >
                <MessageSquare size={21} />
              </IconButton>
              <IconButton
                label="Интеграции"
                aria-pressed={panel === 'services'}
                className={panel === 'services' ? 'selected' : ''}
                onClick={() => togglePanel('services')}
              >
                <Music2 size={21} />
              </IconButton>
            </div>
          </footer>
        </main>
        {panel && (
          <>
            <div
              className="panel-resizer"
              role="separator"
              tabIndex={0}
              aria-label="Ширина боковой панели"
              aria-orientation="vertical"
              aria-valuemin={320}
              aria-valuemax={480}
              aria-valuenow={width}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') {
                  e.preventDefault();
                  setPanelWidth(width + 16);
                }
                if (e.key === 'ArrowRight') {
                  e.preventDefault();
                  setPanelWidth(width - 16);
                }
              }}
              onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
              onPointerMove={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  setPanelWidth(window.innerWidth - e.clientX - 16);
              }}
            />
            <Sidebar
              meeting={meeting}
              panel={panel}
              setPanel={setPanel}
              onClose={() => setPanel(null)}
              onInvite={() => setInvite(true)}
            />
          </>
        )}
      </div>

      <AudioLayer tracks={tracks} onBlocked={audioNeedsGesture} volumes={volumes} deafened={deafened} />
      <Invite meeting={meeting} open={invite} onOpenChange={setInvite} />
      <Settings meeting={meeting} open={settings} onOpenChange={setSettings} />
      {diagnostics && (
        <Suspense fallback={null}>
          <Diagnostics meeting={meeting} onClose={() => setDiagnostics(false)} />
        </Suspense>
      )}
    </div>
  );
}
