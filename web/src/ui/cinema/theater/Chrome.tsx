import { useMemo, useRef, type CSSProperties, type RefObject } from 'react';
import {
  Clapperboard,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Radio,
  RotateCcw,
  RotateCw,
  SkipBack,
  Tv,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { Participant, Watch } from '../../../api/types';
import { clock, type CinemaSource } from '../../../core/cinema';
import type { Meeting } from '../../../core/meeting';
import { IconButton, Slider } from '../../primitives';
import { CaptionsMenu } from './menus/CaptionsMenu';
import { QualityMenu, type QualityPage } from './menus/QualityMenu';
import { SyncButton } from './SyncButton';
import type { useCaptions } from './useCaptions';
import type { usePlayback } from './usePlayback';
import type { useRoomSync } from './useRoomSync';
import { playToggle } from './watch-controls';
import { qualities } from './watch-levels';

/**
 * Шаг перемотки кнопками, миллисекунды.
 *
 * Пятнадцать секунд — не круглое число, а привычка: столько отматывают плееры, у которых это
 * есть, и рука к ним уже приучена. Перемотка общая, как и пауза: комната смотрит одно кино, и
 * «отмотать себе» означало бы смотреть его в одиночку.
 */
const SKIP_MS = 15000;
/**
 * Отставание, которое для эфира нормально.
 *
 * У края эфира есть запас — три сегмента, — и это не задержка, а цена устойчивости: без него
 * любая заминка в сети останавливает картинку. Измерено на Twitch: обычное отставание около
 * пяти-шести секунд. Поэтому «мы на краю» — это не ноль, и красная точка горит до
 * {@link LIVE_EDGE}; дальше она гаснет, показывает число и предлагает вернуться.
 */
const LIVE_EDGE = 7;

/**
 * Пульт: что открыто и кто принёс, середина кадра, лента времени и кнопки.
 *
 * Лежит поверх кадра одним слоем: так полный экран разворачивает плеер вместе с пультом, а не
 * кадр без него. Верхняя строка — что открыто и кто принёс, нижняя — лента времени и кнопки.
 */
export function Chrome({
  meeting,
  watch,
  source,
  live,
  canControl,
  owner,
  self,
  onBrowse,
  shown,
  center,
  playing,
  behind,
  volume,
  sync,
  player,
  captions,
  menu,
  onMenu,
  menuPage,
  onMenuPage,
  captionMenu,
  onCaptionMenu,
  screen,
  fullscreen,
  onFullscreen,
}: {
  meeting: Meeting;
  watch: Watch;
  source: CinemaSource | null;
  live: boolean;
  canControl: boolean;
  /** Кто открыл просмотр — для подписи «Открыли вы» или «Открыл …». */
  owner: Participant | undefined;
  self: Participant | undefined;
  onBrowse?: () => void;
  /** Виден ли пульт (`controlsShown`). */
  shown: boolean;
  /** Видна ли середина кадра: отмотать, остановить, отмотать. */
  center: boolean;
  playing: boolean;
  /** Отстали от комнаты настолько, что это видно глазом. */
  behind: boolean;
  volume: number;
  sync: Pick<
    ReturnType<typeof useRoomSync>,
    'position' | 'duration' | 'buffered' | 'lag' | 'over' | 'send' | 'command' | 'skip' | 'resync'
  >;
  player: Pick<
    ReturnType<typeof usePlayback>,
    'levels' | 'level' | 'automatic' | 'voices' | 'voice' | 'texts' | 'chooseVoice' | 'chooseLevel'
  >;
  captions: Pick<ReturnType<typeof useCaptions>, 'text' | 'caption' | 'chooseText'>;
  menu: boolean;
  onMenu: (open: boolean) => void;
  menuPage: QualityPage;
  onMenuPage: (page: QualityPage) => void;
  captionMenu: boolean;
  onCaptionMenu: (open: boolean) => void;
  /** Плеер целиком: сюда же уходят меню, чтобы их было видно и в полном экране. */
  screen: RefObject<HTMLDivElement | null>;
  fullscreen: boolean;
  onFullscreen: () => void;
}) {
  const { position, duration, buffered, lag, over, send, command, skip, resync } = sync;
  const { levels, voices, texts } = player;
  const choices = useMemo(() => qualities(levels), [levels]);
  const title = source?.title ?? watch.title ?? 'Совместный просмотр';
  // «Играть/пауза» — одна и та же кнопка посреди кадра и в полосе пульта (`playToggle`).
  const toggle = playToggle({ paused: watch.paused, over, playing });
  return (
    <div className="watch-chrome" data-shown={shown ? 'true' : undefined}>
      <div className="watch-head">
        <span className="watch-title">
          {live ? <Radio size={15} /> : <Tv size={15} />}
          <b>{title}</b>
          <small>
            {source?.notice ||
              (live
                ? `Эфир · ${source?.author || watch.contentId}`
                : behind
                  ? 'Догоняем комнату…'
                  : owner
                    ? `Открыл${owner.id === self?.id ? 'и вы' : ` ${owner.name}`}`
                    : 'Смотрим вместе')}
          </small>
        </span>
        {/* На телефоне подпись прячется, а имя кнопки остаётся: без него это была бы
            кнопка без названия — и для голосового доступа, и для проверок. */}
        {onBrowse && (
          <button className="watch-browse" aria-label="Каталог" onClick={onBrowse}>
            <Clapperboard size={16} />
            <span>Каталог</span>
          </button>
        )}
        {canControl && (
          <IconButton label="Закрыть просмотр для всех" onClick={() => send('watch.close')}>
            <X size={19} />
          </IconButton>
        )}
      </div>
      {/*
        Середина кадра: отмотать, остановить, отмотать. Здесь её ждут пальцем — и здесь же
        она честно говорит, что пауза общая: комната останавливается вся сразу.
      */}
      <div className="watch-center" data-shown={center ? 'true' : undefined}>
        {center && (
          <>
            <IconButton
              label="Назад на 15 секунд для всех"
              className="watch-skip"
              disabled={!canControl || !duration}
              onClick={() => skip(-SKIP_MS)}
            >
              <RotateCcw size={22} />
              <span>15</span>
            </IconButton>
            <IconButton
              label={toggle.label}
              className="watch-center-play"
              disabled={!canControl}
              onClick={() => command(toggle.command)}
            >
              {toggle.icon === 'play' ? <Play size={30} /> : <Pause size={30} />}
            </IconButton>
            <IconButton
              label="Вперёд на 15 секунд для всех"
              className="watch-skip"
              disabled={!canControl || !duration}
              onClick={() => skip(SKIP_MS)}
            >
              <RotateCw size={22} />
              <span>15</span>
            </IconButton>
          </>
        )}
      </div>
      <div className="watch-foot">
        {!live && (
          <div className="watch-line">
            <span className="watch-time">{clock(position / 1000)}</span>
            <Slider
              className="watch-progress"
              min={0}
              max={Math.max(1000, duration)}
              step={1000}
              value={Math.min(position, duration || position)}
              disabled={!canControl || !duration}
              aria-label="Положение в ролике"
              style={
                {
                  '--slider-b': Math.min(1, buffered / Math.max(1000, duration)),
                } as CSSProperties
              }
              onChange={(event) => command('watch.seek', Number(event.target.value))}
            />
            <span className="watch-time">{clock(duration / 1000)}</span>
          </div>
        )}
        <div className="watch-tools">
          {/*
            У эфира на месте «играть» стоит «LIVE»: останавливать его нельзя, а вот
            вернуться к краю после затычки в сети — самое частое, чего от него хотят.
          */}
          {live ? (
            <button
              className="watch-live"
              data-edge={lag > LIVE_EDGE ? undefined : 'true'}
              aria-label={
                lag > LIVE_EDGE ? `Вернуться к эфиру, отстали на ${Math.round(lag)} с` : 'Идёт эфир'
              }
              onClick={resync}
            >
              <span className="watch-live-dot" />
              LIVE
              {lag > LIVE_EDGE && <small>−{Math.round(lag)} с</small>}
            </button>
          ) : (
            <>
              <IconButton
                label={toggle.label}
                className="watch-play"
                disabled={!canControl}
                onClick={() => command(toggle.command)}
              >
                {toggle.icon === 'play' ? <Play size={21} /> : <Pause size={21} />}
              </IconButton>
              <IconButton
                label="В начало для всех"
                disabled={!canControl}
                onClick={() => command('watch.seek', 0)}
              >
                <SkipBack size={18} />
              </IconButton>
            </>
          )}
          {/*
            У эфира этой кнопки нет: «обновить» и «LIVE» делали одно и то же действие
            (`resync`) и стояли рядом — вторая ручка от того же самого. У записи она
            остаётся, и смысл у неё другой: встать туда, где комната.
          */}
          {!live && <SyncButton behind={behind} onSync={resync} />}
          <Volume meeting={meeting} volume={volume} />
          <span className="watch-gap" />
          {texts.length > 0 && (
            <CaptionsMenu
              texts={texts}
              text={captions.text}
              caption={captions.caption}
              open={captionMenu}
              onOpenChange={onCaptionMenu}
              container={screen}
              onChoose={captions.chooseText}
            />
          )}
          {(choices.length > 1 || voices.length > 1) && (
            <QualityMenu
              open={menu}
              onOpenChange={onMenu}
              page={menuPage}
              onPage={onMenuPage}
              container={screen}
              levels={levels}
              level={player.level}
              automatic={player.automatic}
              choices={choices}
              voices={voices}
              voice={player.voice}
              onLevel={player.chooseLevel}
              onVoice={player.chooseVoice}
            />
          )}
          <IconButton
            label={fullscreen ? 'Выйти из полноэкранного режима' : 'Развернуть плеер'}
            onClick={onFullscreen}
          >
            {fullscreen ? <Minimize2 size={19} /> : <Maximize2 size={19} />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}

/** Громкость просмотра — своя у каждого: комната о ней не знает. */
function Volume({ meeting, volume }: { meeting: Meeting; volume: number }) {
  /** Громкость до «без звука»: туда же она и возвращается. */
  const loudness = useRef(Math.max(8, volume || 70));
  const setVolume = (value: number) => {
    if (value > 0) loudness.current = value;
    meeting.media.saveSettings({ watchVolume: value });
  };
  const muted = volume <= 0;
  return (
    <div className="watch-volume">
      <IconButton
        label={muted ? 'Включить звук просмотра' : 'Выключить звук просмотра'}
        onClick={() => setVolume(muted ? loudness.current : 0)}
      >
        {muted ? <VolumeX size={18} /> : volume < 50 ? <Volume1 size={18} /> : <Volume2 size={18} />}
      </IconButton>
      <Slider
        min={0}
        max={100}
        step={1}
        value={volume}
        aria-label="Громкость просмотра"
        onChange={(event) => setVolume(Number(event.target.value))}
      />
    </div>
  );
}
