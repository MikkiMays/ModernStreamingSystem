import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp, Headphones, PhoneOff, Users, Wifi, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { useMediaQuery, useStore } from './primitives';
import { Stage, AudioLayer } from './Stage';
import { StageOverlay } from './StageOverlay';
import { CallDock } from './CallDock';
import { Sidebar, type Panel } from './Sidebar';
import { Invite } from './Invite';
import { MeetingSettings } from './MeetingSettings';
import { Settings } from './Settings';
import type { Theme } from './Home';
import { MeetingHeader } from './MeetingHeader';
import { PresenceAsk, usePresence } from './abuse/Presence';
import { Button, IconButton, ResizeHandle, usePanelWidth } from './kit';
import { humans } from '../core/people';
import {
  hotkeyFromMouse,
  isMouseHotkey,
  isTyping,
  matchesHotkey,
  matchesMouseHotkey,
  releasesHotkey,
} from '../core/hotkeys';
import { MicHotkey } from '../core/mic-hotkey';
import { hasFeature, notifyDesktop, onDesktopCommand, onNotificationAction } from '../core/desktop';
import { desktopSettingsAvailable, toggleDesktopOverlay } from '../core/desktop-settings';
import { useFullscreen } from '../core/fullscreen';
import { allowed, type RoomAction } from '../core/permissions';
import { COMPACT } from './breakpoints';
import { useYieldToCinema } from './cinema/useYieldToCinema';
import { HelpButton } from './support/HelpButton';
import { closeHelp, openHelp, provideCallReport } from './support/help';
import { BackgroundNote } from './BackgroundNote';
import { useCallInBackground } from './useCallInBackground';
import { useDesktopOverlay } from './useDesktopOverlay';
import { useTrayChat } from './useTrayChat';

const Diagnostics = lazy(() => import('./Diagnostics'));
/** Окна поверх встречи — одно за раз (S5). */
type Layer = 'invite' | 'settings' | 'diagnostics' | 'meetingSettings';
export function MeetingView({
  meeting,
  onHome,
  theme,
  setTheme,
  section,
  onSectionClosed,
  onBackTarget,
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
  /**
   * Что закрыть кнопкой «Назад» оболочки (Mini App Telegram, E09): открытая панель — или `null`,
   * тогда кнопка не нужна. Сама встреча этой кнопкой не закрывается: выход — своей кнопкой.
   */
  onBackTarget?: (close: (() => void) | null) => void;
}) {
  const { t } = useTranslation();
  const snapshot = useStore(meeting.snapshot);
  const viewing = useStore(meeting.viewing);
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
  // «Вы ещё здесь?» (A2): браузер сам говорит ядру, что за ним кто-то есть, пока встреча идёт.
  const presence = usePresence(meeting, !ended);
  // Оболочке — не только «во встрече», но и микрофон, камера и показ: по ним кнопки на миниатюре,
  // значок поверх иконки («микрофон выключен»), пункт трея и запрет сна (T53).
  useEffect(() => {
    notifyDesktop('call-state', {
      inCall: !ended,
      mic: !ended && media.microphone,
      camera: !ended && media.camera,
      screen: !ended && media.screen,
    });
  }, [ended, media.microphone, media.camera, media.screen]);
  const [panel, setPanel] = useState<Panel | null>(null);
  /*
    Каталог и фильм, открытые самим человеком, не остаются под панелью интеграций, из которой их
    и открыли: на экране уже 960 px она лежит поверх сцены. Чат и люди при этом не закрываются
    никогда, а чужой фильм и смена ширины панель не трогают — подробности в самом правиле.
  */
  useYieldToCinema(meeting, setPanel);
  useTrayChat(setPanel);
  useEffect(() => {
    onBackTarget?.(panel ? () => setPanel(null) : null);
  }, [panel, onBackTarget]);
  // Открытый чат — прочитанный чат (R87), и уведомлять о его сообщениях незачем (R59).
  useEffect(() => {
    meeting.chatOpen.set(panel === 'chat');
  }, [meeting, panel]);
  // Нажатие в уведомлении Windows: «Впустить» и «Отклонить» решает встреча, здесь — какую панель открыть.
  useEffect(
    () =>
      onNotificationAction(({ id, tag }) => {
        const open = meeting.handleNotificationAction(id, tag);
        if (open) setPanel(open);
      }),
    [meeting],
  );
  /*
    Окно поверх встречи — одно за раз (S5, R49): приглашение, настройки, диагностика и настройки
    встречи. Открыть другое — значит заменить, а не положить сверху; помощь (`HelpHost`) тоже уходит.
    Стопкой окно ложилось под чужой слой или ловило «нажатие снаружи» и закрывалось.
  */
  const [layer, setLayer] = useState<Layer | null>(null);
  const show = useCallback((next: Layer) => {
    closeHelp();
    setLayer(next);
  }, []);
  const hide = (which: Layer) => setLayer((current) => (current === which ? null : current));
  const toggle = (which: Layer) => (open: boolean) => (open ? show(which) : hide(which));
  // Поддержка из диагностики: диагностика закрывается, поддержка открывается — и умеет вернуть её.
  // «Сообщить о проблеме» (R79) — сразу с выбором того, что не так, и отчётом этого звонка.
  const helpFromDiagnostics = (report = false) => {
    setLayer(null);
    openHelp({ faq: 'network', onDiagnostics: () => show('diagnostics'), report });
  };
  // Встреча ушла с экрана — её помощь (с «Открыть диагностику» этой встречи) тоже.
  useEffect(() => closeHelp, []);
  // Итог этого звонка — для «Сообщить о проблеме», откуда бы поддержку ни открыли, пока встреча на экране.
  useEffect(() => provideCallReport(() => meeting.media.callReport()), [meeting]);
  useEffect(() => {
    if (section) show('settings');
  }, [section, show]);
  const preferences = useStore(meeting.media.preferences);
  const volumes = useStore(meeting.media.volumes);
  const deafened = useStore(meeting.media.deafened);
  /* Ширина правой панели — тем же механизмом, что и левая на главной (T46, П11): ручка с курсором
     `col-resize`, ширина помнится на устройстве. */
  const panelWidth = usePanelWidth('meeting-panel', { min: 320, max: 480, default: 360 });
  const [audioBlocked, setAudioBlocked] = useState(false);
  const audioNeedsGesture = useCallback(() => setAudioBlocked(true), []);
  /** Свой `AudioContext` уснул (фон, обычный звонок, перезагрузка без касания) — нужна та же кнопка. */
  const audioAsleep = useStore(meeting.media.audio.blocked);
  const leaveMeeting = () => {
    void meeting.leave();
    onHome();
  };
  useCallInBackground(meeting, leaveMeeting);
  useEffect(() => {
    meeting.start();
    return () => meeting.dispose();
  }, [meeting]);
  useEffect(() => {
    const live = () => !meeting.ended.get() && meeting.media.state.get().status === 'connected';
    const toggle = () => {
      if (live()) void meeting.media.toggle('microphone');
    };
    /*
      «Нажми и говори» (E01-B3) — только с Raw Input оболочки (флаг `ptt`): без фазы «отпустил»
      микрофон остался бы включённым. Raw Input видит и нажатия в окне Cord, не отбирая их у
      страницы, — `MicHotkey` сводит пару «страница + оболочка» в одно нажатие.
    */
    const native = hasFeature('ptt');
    const mode = native ? preferences.micHotkeyMode : 'toggle';
    const mic = new MicHotkey(mode, {
      toggle,
      set: (on) => {
        if (live()) void meeting.media.setMicrophone(on);
      },
    });
    const micKey = preferences.micHotkey;
    let held = false;
    const keyboard = (event: KeyboardEvent) => {
      if (event.repeat || isTyping(event.target) || document.querySelector('[role="dialog"]')) return;
      if (matchesHotkey(event, micKey)) {
        event.preventDefault();
        held = true;
        mic.press('page', 'down');
      } else if (!native && matchesHotkey(event, preferences.overlayHotkey) && desktopSettingsAvailable()) {
        // Сочетание оверлея без Ctrl/Alt в системе не регистрируется — в окне встречи оно всё равно
        // работает. С Raw Input оболочка ловит его и в окне Cord сама: второй раз переключать нельзя.
        event.preventDefault();
        void toggleDesktopOverlay();
      }
    };
    const release = (event: KeyboardEvent) => {
      if (!held || !releasesHotkey(event, micKey)) return;
      held = false;
      mic.press('page', 'up');
    };
    // Кнопка мыши в сочетании (Mouse3–Mouse5) — в окне встречи так же, как клавиша.
    const mouseDown = (event: MouseEvent) => {
      if (!matchesMouseHotkey(event, micKey) || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      held = true;
      mic.press('page', 'down');
    };
    const mouseUp = (event: MouseEvent) => {
      if (!held || hotkeyFromMouse(event)?.code !== micKey?.code) return;
      held = false;
      mic.press('page', 'up');
    };
    notifyDesktop('hotkey.configure', {
      hotkey: ended ? null : micKey,
      overlay: ended ? null : preferences.overlayHotkey,
      lock: ended ? null : preferences.overlayLockHotkey,
      mode,
    });
    window.addEventListener('keydown', keyboard);
    window.addEventListener('keyup', release);
    const mouse = !!micKey && isMouseHotkey(micKey);
    if (mouse) {
      window.addEventListener('mousedown', mouseDown);
      window.addEventListener('mouseup', mouseUp);
    }
    const unsubscribe = onDesktopCommand((command) => {
      if (command.type === 'microphone.toggle') mic.press('shell', 'down');
      if (command.type === 'microphone.hold' && command.phase) mic.press('shell', command.phase);
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
      window.removeEventListener('keyup', release);
      if (mouse) {
        window.removeEventListener('mousedown', mouseDown);
        window.removeEventListener('mouseup', mouseUp);
      }
      unsubscribe();
      notifyDesktop('hotkey.configure', { hotkey: null, overlay: null, lock: null });
    };
  }, [
    meeting,
    preferences.micHotkey,
    preferences.micHotkeyMode,
    preferences.overlayHotkey,
    preferences.overlayLockHotkey,
    ended,
  ]);
  // Окна оболочки поверх других программ (R63, R93, R104): виджет говорящих в игре и мини-окно звонка.
  useDesktopOverlay(meeting, !!ended, {
    setPanel,
    openSettings: () => show('settings'),
    leave: leaveMeeting,
  });
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
      <MeetingHeader
        meeting={meeting}
        canEdit={may('room.settings')}
        onInvite={() => show('invite')}
        onSettings={() => show('meetingSettings')}
        onDiagnostics={() => show('diagnostics')}
      />
      <div className={`meeting-body ${panel ? 'panel-open' : ''}`}>
        <main className="stage-wrap" aria-label={t(($) => $.meeting.view.stage)}>
          {!ended &&
            may('participant.approve') &&
            snapshot.participants.some((p) => p.status === 'WAITING') && (
              <button className="admission-banner" onClick={() => setPanel('people')}>
                <Users size={16} />{' '}
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
          {!ended && <PresenceAsk snapshot={snapshot} presence={presence} />}
          {!ended && control === 'recovering' && media.status === 'connected' && (
            <div className="control-banner media-stage" role="status">
              {t(($) => $.meeting.view.controlRecovering)}
            </div>
          )}
          {ended ? (
            <div className="ended-stage media-stage">
              <span className="ended-icon">
                <PhoneOff size={32} />
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
              {/* Активные интеграции — чипами поверх сцены справа сверху (R30). Со сцены панель
                  открывают, а не переключают: нажатие при открытой панели закрывало бы её. */}
              <StageOverlay meeting={meeting} onOpenServices={() => setPanel('services')} />
              <Stage meeting={meeting} />
              {/* Из чужого экрана — в разговор; закреплённую камеру открепляют на ней самой (R83). */}
              {viewing && (
                <button
                  className="return-conversation media-stage"
                  onClick={() => meeting.returnToConversation()}
                >
                  <ArrowLeft size={16} /> {t(($) => $.meeting.view.returnToConversation)}
                </button>
              )}
            </>
          )}
          {(audioBlocked || audioAsleep) && !ended && (
            <Button
              variant="primary"
              size="lg"
              className="audio-unlock"
              icon={<Headphones />}
              onClick={() => void meeting.media.unlockAudio().then(() => setAudioBlocked(false))}
            >
              {t(($) => $.meeting.view.unlockAudio)}
            </Button>
          )}
          {/* Кнопка «Включить звук» стоит на том же месте и важнее подсказки. */}
          {!(audioBlocked || audioAsleep) && <BackgroundNote meeting={meeting} />}
          {media.error && !ended && (
            <div className="media-error media-stage" role="alert">
              <span>{media.error}</span>
              {/* Не вышли в эфир — помощь с диагностикой этой встречи, не уходя из неё (T36). */}
              <HelpButton tone="stage" onDiagnostics={() => show('diagnostics')} />
              <IconButton
                tone="stage"
                label={t(($) => $.meeting.view.dismissError)}
                onClick={() => meeting.media.clearError()}
              >
                <X size={20} />
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
              {controlsVisible ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
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
            onLeave={leaveMeeting}
            onSettings={() => show('settings')}
            onDiagnostics={() => show('diagnostics')}
            onMeetingSettings={may('room.settings') ? () => show('meetingSettings') : undefined}
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
              onInvite={() => show('invite')}
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
      <Invite meeting={meeting} open={layer === 'invite'} onOpenChange={toggle('invite')} />
      {may('room.settings') && (
        <MeetingSettings
          meeting={meeting}
          open={layer === 'meetingSettings'}
          onOpenChange={toggle('meetingSettings')}
        />
      )}
      <Settings
        meeting={meeting}
        open={layer === 'settings'}
        section={section}
        theme={theme}
        setTheme={setTheme}
        onOpenChange={(open) => {
          toggle('settings')(open);
          if (!open) onSectionClosed?.();
        }}
      />
      {layer === 'diagnostics' && (
        <Suspense fallback={null}>
          <Diagnostics
            meeting={meeting}
            onClose={() => hide('diagnostics')}
            onHelp={() => helpFromDiagnostics()}
            onReport={() => helpFromDiagnostics(true)}
          />
        </Suspense>
      )}
    </div>
  );
}
