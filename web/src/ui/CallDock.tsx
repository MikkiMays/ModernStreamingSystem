import {
  Activity,
  HeadphoneOff,
  Headphones,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  MonitorX,
  MoreHorizontal,
  Pencil,
  PhoneOff,
  PictureInPicture2,
  Puzzle,
  Settings2,
  Users,
  Video,
  VideoOff,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { desktopCaptureAudio, desktopPicker, selectCaptureSource } from '../core/desktop-capture';
import type { Meeting } from '../core/meeting';
import { CapturePicker, type CaptureChoice } from './CapturePicker';
import { deviceCapture } from '../media/capture';
import { IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './kit';
import { useMediaQuery, useStore } from './primitives';
import { CameraFlip, CameraSubmenu } from './CameraMenu';
import { LayoutChoices, LayoutMenu } from './LayoutMenu';
import type { Panel } from './Sidebar';
import { shareRequests } from './useDesktopOverlay';

/** Больше девяти — «9+»: кружок не растягивается в пилюлю из трёх цифр. */
const unreadText = (count: number) => (count > 9 ? '9+' : String(count));

/** Красный кружок с числом на правом верхнем углу кнопки; для диктора число — в имени кнопки. */
function UnreadBadge({ count }: { count: number }) {
  return (
    <span className="dock-badge" aria-hidden="true">
      {unreadText(count)}
    </span>
  );
}

export interface CallDockProps {
  meeting: Meeting;
  /** Телефон (`COMPACT`): правая группа и инструменты сцены уходят в «ещё». */
  compact: boolean;
  ended: boolean;
  panel: Panel | null;
  togglePanel: (panel: Panel) => void;
  /** Люди без ботов — число на кнопке «Участники». */
  people: number;
  fullscreen: boolean;
  toggleFullscreen: () => void;
  onLeave: () => void;
  onSettings: () => void;
  onDiagnostics: () => void;
  /** Есть права — пункты ведущего; нет — их нет вовсе, а не серые. */
  onMeetingSettings?: () => void;
  onCloseForAll?: () => void;
}

/**
 * Пульт звонка — три отдельные группы (T22, П6).
 *
 * Слева то, чем человек присутствует: микрофон, камера и экран (на касании — переворот камеры:
 * экран с телефона не показывают). В центре — «ещё» и «выйти». Справа — то, что открывает панель:
 * чат, участники, интеграции. Группы — плашки на сцене с зазором между ними, как у Discord: так
 * «выйти» не стоит вплотную к камере, а чат не путается с микрофоном. Расположение участников и
 * полный экран — тихими значками справа, отдельно от групп (референс владельца IMG_5883).
 *
 * На телефоне — две группы в одну строку от 320 px; правая группа, расположение и полный экран
 * уходят в «ещё», где у каждого пункта есть название.
 */
export function CallDock({
  meeting,
  compact,
  ended,
  panel,
  togglePanel,
  people,
  fullscreen,
  toggleFullscreen,
  onLeave,
  onSettings,
  onDiagnostics,
  onMeetingSettings,
  onCloseForAll,
}: CallDockProps) {
  const { t } = useTranslation();
  const media = useStore(meeting.media.state);
  const deafened = useStore(meeting.media.deafened);
  const outbound = useStore(meeting.media.outbound);
  const preferences = useStore(meeting.media.preferences);
  const profile = preferences.screen;
  /** Своя камера — в «Устройствах» окна показа её нет. */
  const camera = preferences.devices?.camera;
  /** «Свернуть в окно» (E12): только когда есть чья-то картинка и браузер умеет. */
  const pip = useStore(meeting.media.pip.state);
  /** Касание: третья кнопка слева — переворот камеры, а показ экрана — в «ещё». */
  const coarse = useMediaQuery('(pointer: coarse)');
  const live = !ended && media.status === 'connected';
  /** Непрочитанные в чате (R87) — кружком на кнопке чата, на телефоне — на «ещё». */
  const unread = useStore(meeting.unread);
  /*
    Показ экрана. В клиенте на Electron источник выбирают в нашем окне (E01-B2): выбор уходит
    оболочке запросом с ответом, и только потом `getDisplayMedia` — оболочка отдаст ровно его.
    Остановить показ и браузер — как раньше, прямо из нажатия. Звук приложения и «система кроме
    Cord» (E01-B3) приходят от оболочки отдельной дорожкой — встреча подписывается на неё сама.
  */
  const [picking, setPicking] = useState(false);
  const share = () => {
    if (!media.screen && desktopPicker()) {
      setPicking(true);
      return;
    }
    meeting.media.share(profile);
  };
  // «Показать экран» из мини-окна звонка (R93): окно Cord уже впереди — то же, что нажатие на пульте.
  const shareLatest = useRef(share);
  useLayoutEffect(() => {
    shareLatest.current = share;
  });
  useEffect(() => shareRequests.subscribe(() => shareLatest.current()), []);
  const shareChosen = async (choice: CaptureChoice) => {
    setPicking(false);
    // Выбор окна показа помнится (R60): следующий показ откроется с тем же режимом, качеством и звуком.
    meeting.media.saveSettings({ screen: choice.profile });
    if (choice.kind === 'device') {
      // Карта захвата или виртуальная камера — своим захватом, дальше тот же путь показа.
      meeting.media.share(choice.profile, undefined, () =>
        deviceCapture(choice.deviceId, choice.profile, choice.sound),
      );
      return;
    }
    await selectCaptureSource(choice.id, choice.audio);
    meeting.media.share(choice.profile, desktopCaptureAudio(choice.audio));
  };
  // Что уходит в сеть прямо сейчас — подсказкой у «Диагностики»: раньше это была метка в пульте.
  const sending = outbound && outbound.width > 0 ? `${outbound.height}p · ${outbound.fps} fps` : null;
  return (
    <footer id="meeting-controls" className="call-footer media-stage" data-compact={compact || undefined}>
      <div className="call-dock">
        <div className="dock-group" role="group" aria-label={t(($) => $.dock.media)}>
          <IconButton
            tone="stage"
            size="lg"
            className="dock-button"
            label={media.microphone ? t(($) => $.dock.micOn) : t(($) => $.dock.micOff)}
            aria-pressed={media.microphone}
            disabled={!live}
            onClick={() => void meeting.media.toggle('microphone')}
          >
            {media.microphone ? <Mic size={24} /> : <MicOff size={24} />}
          </IconButton>
          <IconButton
            tone="stage"
            size="lg"
            className="dock-button"
            label={media.camera ? t(($) => $.dock.cameraOn) : t(($) => $.dock.cameraOff)}
            aria-pressed={media.camera}
            disabled={!live}
            onClick={() => void meeting.media.toggle('camera')}
          >
            {media.camera ? <Video size={24} /> : <VideoOff size={24} />}
          </IconButton>
          {coarse ? (
            <CameraFlip meeting={meeting} disabled={!!ended} />
          ) : media.screen ? (
            /* Идёт показ — красная кнопка с крестиком (R77): остановить видно издалека, нажатие
               снимает показ сразу и у всех (R81). */
            <IconButton
              variant="danger"
              size="lg"
              className="dock-button dock-stop"
              label={t(($) => $.dock.unshare)}
              disabled={!live}
              onClick={share}
            >
              <MonitorX size={24} />
            </IconButton>
          ) : (
            <IconButton
              tone="stage"
              size="lg"
              className="dock-button dock-toggle"
              label={t(($) => $.dock.share)}
              pressed={false}
              disabled={!live}
              onClick={share}
            >
              <MonitorUp size={24} />
            </IconButton>
          )}
        </div>
        <div className="dock-group" role="group" aria-label={t(($) => $.dock.call)}>
          <Menu>
            <MenuTrigger
              render={
                <IconButton tone="stage" size="lg" className="dock-button" label={t(($) => $.dock.more)}>
                  <MoreHorizontal size={24} />
                  {/* На телефоне чат — в «ещё»: кружок непрочитанных переезжает сюда (R87). */}
                  {compact && unread > 0 && <UnreadBadge count={unread} />}
                </IconButton>
              }
            />
            <MenuContent side="top" align="center" sideOffset={12} className="dock-menu">
              <MenuItem
                icon={deafened ? <Headphones /> : <HeadphoneOff />}
                onClick={() => meeting.media.deafened.set(!deafened)}
              >
                {deafened ? t(($) => $.dock.undeafen) : t(($) => $.dock.deafen)}
              </MenuItem>
              {coarse && (
                <MenuItem icon={<MonitorUp />} disabled={!live} onClick={share}>
                  {media.screen ? t(($) => $.dock.unshare) : t(($) => $.dock.share)}
                </MenuItem>
              )}
              {!coarse && <CameraSubmenu meeting={meeting} />}
              {(pip.available || pip.active) && (
                <MenuItem icon={<PictureInPicture2 />} onClick={() => meeting.media.pip.toggle()}>
                  {pip.active ? t(($) => $.dock.pipClose) : t(($) => $.dock.pip)}
                </MenuItem>
              )}
              {compact && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon={<MessageSquare />}
                    shortcut={unread > 0 ? unreadText(unread) : undefined}
                    onClick={() => togglePanel('chat')}
                  >
                    {t(($) => $.dock.chatAndFiles)}
                  </MenuItem>
                  <MenuItem icon={<Users />} shortcut={String(people)} onClick={() => togglePanel('people')}>
                    {t(($) => $.dock.people)}
                  </MenuItem>
                  <MenuItem icon={<Puzzle />} onClick={() => togglePanel('services')}>
                    {t(($) => $.dock.integrations)}
                  </MenuItem>
                  <MenuSeparator />
                  <LayoutChoices meeting={meeting} />
                  <MenuItem icon={fullscreen ? <Minimize2 /> : <Maximize2 />} onClick={toggleFullscreen}>
                    {fullscreen ? t(($) => $.dock.windowed) : t(($) => $.dock.fullscreen)}
                  </MenuItem>
                </>
              )}
              <MenuSeparator />
              <MenuItem icon={<Settings2 />} onClick={onSettings}>
                {t(($) => $.dock.settings)}
              </MenuItem>
              <MenuItem icon={<Activity />} shortcut={sending ?? undefined} onClick={onDiagnostics}>
                {t(($) => $.dock.diagnostics)}
              </MenuItem>
              {onMeetingSettings && (
                <MenuItem icon={<Pencil />} onClick={onMeetingSettings}>
                  {t(($) => $.dock.meetingSettings)}
                </MenuItem>
              )}
              {onCloseForAll && (
                <>
                  <MenuSeparator />
                  <MenuItem icon={<PhoneOff />} destructive onClick={onCloseForAll}>
                    {t(($) => $.dock.closeForAll)}
                  </MenuItem>
                </>
              )}
            </MenuContent>
          </Menu>
          <IconButton
            variant="danger"
            size="lg"
            className="dock-button dock-hangup"
            label={t(($) => $.dock.leave)}
            disabled={ended}
            onClick={onLeave}
          >
            <PhoneOff size={24} />
          </IconButton>
        </div>
        {!compact && (
          <div className="dock-group" role="group" aria-label={t(($) => $.dock.panels)}>
            <IconButton
              tone="stage"
              size="lg"
              className="dock-button dock-toggle"
              label={unread > 0 ? t(($) => $.dock.chatUnread, { count: unread }) : t(($) => $.dock.chat)}
              pressed={panel === 'chat'}
              onClick={() => togglePanel('chat')}
            >
              <MessageSquare size={24} />
              {unread > 0 && <UnreadBadge count={unread} />}
            </IconButton>
            <IconButton
              tone="stage"
              size="lg"
              className="dock-button dock-toggle"
              label={t(($) => $.dock.people)}
              pressed={panel === 'people'}
              onClick={() => togglePanel('people')}
            >
              <Users size={24} />
              <span className="dock-count" aria-hidden="true">
                {people}
              </span>
            </IconButton>
            <IconButton
              tone="stage"
              size="lg"
              className="dock-button dock-toggle"
              label={t(($) => $.dock.integrations)}
              pressed={panel === 'services'}
              onClick={() => togglePanel('services')}
            >
              <Puzzle size={24} />
            </IconButton>
          </div>
        )}
      </div>
      {!compact && (
        <div className="dock-tools">
          <LayoutMenu meeting={meeting} />
          <IconButton
            tone="stage"
            className="dock-tool"
            label={fullscreen ? t(($) => $.dock.windowed) : t(($) => $.dock.fullscreen)}
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize2 size={20} /> : <Maximize2 size={20} />}
          </IconButton>
        </div>
      )}
      <CapturePicker
        open={picking}
        onOpenChange={setPicking}
        onChoose={(choice) => void shareChosen(choice)}
        initial={profile}
        camera={camera}
      />
    </footer>
  );
}
