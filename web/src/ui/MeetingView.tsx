import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, Headphones, Link, PhoneOff, Users, Wifi, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { useMediaQuery, useStore } from './primitives';
import { Stage, AudioLayer } from './Stage';
import { Ping } from './Ping';
import { CallDock } from './CallDock';
import { Sidebar, type Panel } from './Sidebar';
import { Invite } from './Invite';
import { MeetingSettings } from './MeetingSettings';
import { Settings } from './Settings';
import type { Theme } from './Home';
import { MeetingHeader } from './MeetingHeader';
import { Button, IconButton, ResizeHandle, usePanelWidth } from './kit';
import { humans } from '../core/people';
import { isTyping, matchesHotkey } from '../core/hotkeys';
import { hasFeature, notifyDesktop, onDesktopCommand } from '../core/desktop';
import { useFullscreen } from '../core/fullscreen';
import { allowed, type RoomAction } from '../core/permissions';
import { COMPACT } from './breakpoints';
import { useYieldToCinema } from './cinema/useYieldToCinema';
import { HelpButton } from './support/HelpButton';
import { OnceHint } from './onboarding/Onboarding';
import { anchorFor } from '../core/onboarding';

const Diagnostics = lazy(() => import('./Diagnostics'));
export function MeetingView({
  meeting,
  onHome,
  theme,
  setTheme,
  section,
  onSectionClosed,
}: {
  meeting: Meeting;
  onHome: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /**
   * A settings section the host asked for. The profile block in the application's sidebar
   * opens these settings during a meeting too: they are the same settings, and a press that
   * did nothing while the conversation was open only looked like a broken button.
   */
  section?: string;
  onSectionClosed?: () => void;
}) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const viewing = useStore(meeting.viewing);
  const pinned = useStore(meeting.pinnedCamera);
  /*
    На весь экран разворачивается документ, а не страница встречи.

    Меню, диалоги и настройки Base UI рисует в портале — в самом конце `<body>`, то есть вне
    `.meeting-page`. Браузер в полноэкранном режиме показывает только развёрнутый элемент и то,
    что внутри него: пока разворачивалась страница встречи, «Настройки и действия», меню камеры,
    интеграции и диагностика открывались невидимыми — с фокусом, но без картинки. Документ
    целиком содержит и порталы; состояние кнопок при этом по-прежнему одно на всех, его держит
    общий `useFullscreen`.
  */
  const root = useRef<HTMLElement>(document.documentElement);
  const { full: fullscreen, targetFull, toggle: toggleFullscreen } = useFullscreen(root);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const lastActivity = useRef(Date.now());
  const collapseToggle = useRef<HTMLButtonElement>(null);
  const wakeControls = () => {
    lastActivity.current = Date.now();
    if (!controlsCollapsed) setControlsVisible(true);
  };
  useEffect(() => {
    setControlsVisible(true);
    setControlsCollapsed(false);
    lastActivity.current = Date.now();
  }, [fullscreen]);
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
  /** Телефон: часть кнопок не прячется, а переезжает в меню, и это решает разметка. */
  const compact = useMediaQuery(COMPACT);
  const control = useStore(meeting.control.state);
  const ended = useStore(meeting.ended);
  // Первый вход во встречу (T34): одна подсказка у микрофона, камеры и экрана — когда вышли в эфир.
  const live = media.status === 'connected' && !ended;
  const [dock, setDock] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setDock(live ? anchorFor('dock') : null);
  }, [live]);
  useEffect(() => {
    notifyDesktop('call-state', { inCall: !ended });
  }, [ended]);
  const [panel, setPanel] = useState<Panel | null>(null);
  /*
    Каталог и фильм, открытые самим человеком, не остаются под панелью интеграций, из которой их
    и открыли: на экране уже 960 px она лежит поверх сцены. Чат и люди при этом не закрываются
    никогда, а чужой фильм и смена ширины панель не трогают — подробности в самом правиле.
  */
  useYieldToCinema(meeting, setPanel);
  const [invite, setInvite] = useState(false);
  const [settings, setSettings] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [meetingSettings, setMeetingSettings] = useState(false);
  useEffect(() => {
    if (section) setSettings(true);
  }, [section]);
  const preferences = useStore(meeting.media.preferences);
  const volumes = useStore(meeting.media.volumes);
  const deafened = useStore(meeting.media.deafened);
  /* Ширина правой панели — тем же механизмом, что и левая на главной (T46, П11): ручка с курсором
     `col-resize`, ширина помнится на устройстве. */
  const panelWidth = usePanelWidth('meeting-panel', { min: 320, max: 480, default: 360 });
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
      // Кнопки на миниатюре в панели задач (T53): микрофон, камера, завершить.
      if (command.type === 'thumbar') {
        if (command.action === 'mic') toggle();
        if (
          command.action === 'camera' &&
          !meeting.ended.get() &&
          meeting.media.state.get().status === 'connected'
        )
          void meeting.media.toggle('camera');
        if (command.action === 'leave') void meeting.leave();
      }
    });
    return () => {
      window.removeEventListener('keydown', keyboard);
      unsubscribe();
      notifyDesktop('hotkey.configure', { hotkey: null });
    };
  }, [meeting, preferences.micHotkey, ended]);
  // Оверлей клиента (T23, E01): кто в комнате и кто говорит — не чаще 10 раз в секунду, без аватаров.
  useEffect(() => {
    if (!hasFeature('overlay') || ended) return;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const publish = () => {
      timer = null;
      last = Date.now();
      const levels = meeting.media.levels.state.get();
      const speaking = new Set(meeting.media.speaking.get());
      notifyDesktop('overlay.state', {
        participants: humans(meeting.snapshot.get().participants)
          .slice(0, 20)
          .map((p) => ({
            name: p.name.slice(0, 40),
            tier: levels[p.id]?.tier ?? 0,
            speaking: speaking.has(p.id),
          })),
      });
    };
    const schedule = () => {
      if (timer) return;
      const wait = Math.max(0, 100 - (Date.now() - last));
      timer = setTimeout(publish, wait);
    };
    const stops = [meeting.media.levels.watchAll(schedule), meeting.snapshot.subscribe(schedule)];
    schedule();
    return () => {
      stops.forEach((stop) => stop());
      if (timer) clearTimeout(timer);
      notifyDesktop('overlay.state', { participants: [] });
    };
  }, [meeting, ended]);
  const self = snapshot.participants.find((p) => p.id === meeting.admission.participantId);
  // Действия ведущего — по ответу ядра (`you.can`), а не по флажку `owner` в списке людей.
  const may = (action: RoomAction) => allowed(snapshot, meeting.admission.participantId, action);
  const togglePanel = (value: Panel) => setPanel((p) => (p === value ? null : value));
  /** Люди без ботов и интеграций — для счётчиков (T35). */
  const people = humans(snapshot.participants);
  return (
    <div
      className={`meeting-page ${targetFull ? 'meeting-fullscreen' : ''} ${controlsVisible ? '' : 'controls-hidden'}`}
      data-full={targetFull ? 'true' : undefined}
      // Устойчивый признак «медиа подключено» для e2e и оболочек вместо текста «В эфире» (T25).
      data-media-status={ended ? 'ended' : media.status}
      onPointerMove={wakeControls}
      onPointerDown={wakeControls}
      onFocusCapture={wakeControls}
      style={{ '--panel-width': `${panelWidth.width}px` } as CSSProperties}
    >
      <Ping meeting={meeting} />
      <MeetingHeader
        meeting={meeting}
        canEdit={may('room.settings')}
        onInvite={() => setInvite(true)}
        onSettings={() => setMeetingSettings(true)}
        onDiagnostics={() => setDiagnostics(true)}
      />
      <div className={`meeting-body ${panel ? 'panel-open' : ''}`}>
        <main className="stage-wrap" aria-label={t(($) => $.meeting.view.stage)}>
          {!ended &&
            may('participant.approve') &&
            snapshot.participants.some((p) => p.status === 'WAITING') && (
              <button className="admission-banner" onClick={() => setPanel('people')}>
                <Users size={18} />{' '}
                {t(($) => $.meeting.view.requests, {
                  n: snapshot.participants.filter((p) => p.status === 'WAITING').length,
                })}
              </button>
            )}
          {!ended && media.status === 'recovering' && (
            <div className="recovery-banner media-stage" role="status">
              <Wifi size={20} />
              <div>
                <strong>{t(($) => $.meeting.view.recoveryTitle)}</strong>
                <span>{t(($) => $.meeting.view.recoveryText)}</span>
              </div>
              <b>{t(($) => $.meeting.view.seconds, { n: media.remaining })}</b>
            </div>
          )}
          {!ended && control === 'recovering' && media.status === 'connected' && (
            <div className="control-banner media-stage" role="status">
              {t(($) => $.meeting.view.controlRecovering)}
            </div>
          )}
          {!ended && media.liveStatus && control !== 'recovering' && media.status === 'connected' && (
            <div className="control-banner media-stage" role="status">
              {media.liveStatus}
            </div>
          )}
          {ended ? (
            <div className="ended-stage media-stage">
              <span className="ended-icon">
                <PhoneOff size={28} />
              </span>
              <h2>{ended}</h2>
              <p>
                {t(($) => $.meeting.view.thanks)}
                <br />
                {t(($) => $.meeting.view.retention)}
              </p>
              <Button variant="primary" size="lg" icon={<ArrowLeft />} onClick={onHome}>
                {t(($) => $.meeting.view.home)}
              </Button>
              <Button variant="quiet" onClick={() => setPanel('chat')}>
                {t(($) => $.meeting.view.history)}
              </Button>
            </div>
          ) : self?.status === 'WAITING' ? (
            <div className="ended-stage media-stage">
              <span className="waiting-orbit">
                <Users size={32} />
              </span>
              <h2>{t(($) => $.meeting.view.waitingTitle)}</h2>
              <p>
                {t(($) => $.meeting.view.waitingSettle)}
                <br />
                {t(($) => $.meeting.view.waitingMedia)}
              </p>
            </div>
          ) : (
            <>
              <Stage
                meeting={meeting}
                /* Со сцены панель всегда открывают, а не переключают: нажатие «покажи
                   комбинации» при уже открытой панели закрывало бы её. */
                onOpenServices={() => setPanel('services')}
                showServices={showIntegrationPanel}
              />
              {(viewing || pinned) && (
                <button
                  className="return-conversation media-stage"
                  onClick={() => meeting.returnToConversation()}
                >
                  <ArrowLeft size={16} /> {t(($) => $.meeting.view.returnToConversation)}
                </button>
              )}
              {people.length === 1 && !media.screen && (
                <button className="invite-hint media-stage" onClick={() => setInvite(true)}>
                  <Users size={18} />
                  <span>{t(($) => $.meeting.view.inviteHint)}</span>
                  <Link size={16} />
                </button>
              )}
            </>
          )}
          {audioBlocked && (
            <Button
              variant="primary"
              size="lg"
              className="audio-unlock"
              icon={<Headphones />}
              onClick={() => void meeting.media.room.startAudio().then(() => setAudioBlocked(false))}
            >
              {t(($) => $.meeting.view.unlockAudio)}
            </Button>
          )}
          {media.error && !ended && (
            <div className="media-error media-stage" role="alert">
              <span>{media.error}</span>
              {/* Не вышли в эфир — помощь с диагностикой этой встречи, не уходя из неё (T36). */}
              <HelpButton tone="stage" onDiagnostics={() => setDiagnostics(true)} />
              <IconButton
                tone="stage"
                label={t(($) => $.meeting.view.dismissError)}
                onClick={() => meeting.media.clearError()}
              >
                <X size={18} />
              </IconButton>
            </div>
          )}
          {fullscreen && (
            <button
              ref={collapseToggle}
              className="controls-toggle media-stage"
              aria-label={
                controlsVisible
                  ? t(($) => $.meeting.view.collapseControls)
                  : t(($) => $.meeting.view.expandControls)
              }
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
              {!controlsVisible && <span>{t(($) => $.meeting.view.controls)}</span>}
            </button>
          )}
          <CallDock
            meeting={meeting}
            compact={compact}
            ended={!!ended}
            panel={panel}
            togglePanel={togglePanel}
            people={people.length}
            fullscreen={fullscreen}
            toggleFullscreen={toggleFullscreen}
            onLeave={() => {
              void meeting.leave();
              onHome();
            }}
            onSettings={() => setSettings(true)}
            onDiagnostics={() => setDiagnostics(true)}
            onMeetingSettings={may('room.settings') ? () => setMeetingSettings(true) : undefined}
            onCloseForAll={
              may('room.close')
                ? () => void meeting.command('close').catch((e) => meeting.media.report(e))
                : undefined
            }
          />
        </main>
        {panel && (
          <>
            <ResizeHandle
              className="panel-resizer"
              edge="end"
              label={t(($) => $.meeting.view.panelWidth)}
              value={panelWidth.width}
              min={panelWidth.min}
              max={panelWidth.max}
              onChange={panelWidth.setWidth}
              onReset={panelWidth.reset}
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

      <AudioLayer
        tracks={tracks}
        onBlocked={audioNeedsGesture}
        volumes={volumes}
        deafened={deafened}
        master={preferences.outputVolume / 100}
      />
      <Invite meeting={meeting} open={invite} onOpenChange={setInvite} />
      {may('room.settings') && (
        <MeetingSettings meeting={meeting} open={meetingSettings} onOpenChange={setMeetingSettings} />
      )}
      <Settings
        meeting={meeting}
        open={settings}
        section={section}
        theme={theme}
        setTheme={setTheme}
        onOpenChange={(open) => {
          setSettings(open);
          if (!open) onSectionClosed?.();
        }}
      />
      <OnceHint id="meeting" anchor={dock} ready={live && !settings && !diagnostics} side="top" />
      {diagnostics && (
        <Suspense fallback={null}>
          <Diagnostics meeting={meeting} onClose={() => setDiagnostics(false)} />
        </Suspense>
      )}
    </div>
  );
}
