import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  MonitorUp,
  MonitorDown,
  Mic,
  Keyboard,
  User,
  Bell,
  Play,
  Plug,
  Server,
  Palette,
  Waves,
  Info,
  KeyRound,
} from 'lucide-react';
import { Tabs } from '@base-ui/react/tabs';
import type { Meeting } from '../core/meeting';
import {
  automaticProfile,
  readPreferences,
  savePreferences,
  type AudioPreferences,
  type Preferences,
  type Reception,
} from '../core/preferences';
import { Store } from '../core/store';
import { hotkeyFromEvent, hotkeyLabel, defaultMicHotkey, type Hotkey } from '../core/hotkeys';
import { notifyDesktop, desktopHotkeyStatus } from '../core/desktop';
import { DeviceCheck } from './DeviceCheck';
import type { ScreenProfile, FrameRate, Resolution } from '../media/profiles';
import type { NetworkMode } from '../media/playout';
import { gradeName, pathName, unknownLink, type LinkState } from '../media/link-quality';
import { Avatar, Modal, Slider, useStore, type Theme } from './primitives';
import { openPicture } from '../core/avatar';
import { AvatarCropper } from './AvatarCropper';
import { useMicLevel } from './useMicLevel';
import { NotificationSounds, ensureNotificationAudio } from '../core/sounds';
import { currentServerUrl, rememberServer, serverLabel, thisServer } from '../core/servers';
import { disconnect, session } from '../core/session';
import { AboutFields } from './AboutFields';
import { AccountsTab } from './settings/AccountsTab';

/**
 * Картинка профиля: выбрать, обрезать, заменить или убрать.
 *
 * ЗДЕСЬ ЖЕ И ОТКАЗ. Комната картинку **проверяет**, и отказ — такая же часть этого разговора,
 * как согласие. Раньше он проглатывался (`catch(() => {})`), и выглядело это хуже любой
 * ошибки: в настройках новая картинка стоит, у комнаты — старая или никакой. Теперь отказ
 * виден, а местная картинка возвращается к прежней: два места не должны расходиться молча.
 *
 * Выбор раньше показывали только на мышином указателе — «на телефоне это неудобно». Неудобно
 * было кадрирование, а не выбор, и кадрирование давно работает пальцем; телефон же — ровно то
 * место, где лежат все фотографии человека.
 */
function AvatarPicker({
  preferences,
  change,
}: {
  preferences: Preferences;
  change: (patch: Partial<Preferences>) => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Выбранная картинка до того, как выбран кадр: пока она здесь, открыто окно кадрирования.
  const [chosen, setChosen] = useState<ImageBitmap | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const forget = () => {
    chosen?.close();
    setChosen(null);
  };
  /** Поставить картинку и сказать правду о том, чем это кончилось. */
  const apply = async (avatar: string) => {
    const previous = preferences.avatar;
    setError('');
    setBusy(true);
    try {
      await change({ avatar });
    } catch (problem) {
      await change({ avatar: previous }).catch(() => {});
      setError((problem as Error).message || 'Комната не приняла картинку');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <span className="avatar-picker-label">Картинка профиля</span>
      <div className="avatar-picker">
        <Avatar name={preferences.name || 'Вы'} src={preferences.avatar || null} />
        <div className="avatar-picker-actions">
          <input
            ref={file}
            type="file"
            accept="image/*"
            hidden
            aria-label="Выбрать картинку профиля"
            onChange={async (e) => {
              const chosen = e.target.files?.[0];
              e.target.value = '';
              if (!chosen) return;
              setBusy(true);
              setError('');
              try {
                // Кадр выбирается после чтения файла, а не вместо него: в кружок попадёт то,
                // что человек увидит в рамке, а не то, что оказалось в середине снимка.
                setChosen(await openPicture(chosen));
              } catch (problem) {
                setError((problem as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          />
          <button className="button secondary" disabled={busy} onClick={() => file.current?.click()}>
            {busy ? 'Обрабатываем…' : preferences.avatar ? 'Заменить' : 'Выбрать картинку'}
          </button>
          {preferences.avatar && (
            <button className="button ghost" disabled={busy} onClick={() => void apply('')}>
              Убрать
            </button>
          )}
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="form-footnote">
          Её увидят участники встречи. Картинка сжимается до небольшого квадрата — самого подробного, какой
          влезает в бюджет комнаты.
        </p>
      )}
      {chosen && (
        <AvatarCropper
          bitmap={chosen}
          onCancel={forget}
          onSave={(avatar) => {
            void apply(avatar);
            forget();
          }}
        />
      )}
    </div>
  );
}

export function QualityFields({
  kind,
  profile,
  change,
}: {
  kind: 'screen' | 'camera';
  profile: ScreenProfile;
  change: (next: ScreenProfile) => void;
}) {
  const title = kind === 'screen' ? 'Демонстрация экрана' : 'Видео с камеры';
  const label = kind === 'screen' ? 'Экран' : 'Камера';
  return (
    <section className="quality-section" aria-label={title}>
      <h3>
        {kind === 'screen' ? <MonitorUp size={19} /> : <Camera size={19} />}
        {title}
      </h3>
      <div className="settings-row">
        <label>
          Качество
          <select
            aria-label={label + ': качество'}
            value={profile.automatic ? 'auto' : profile.resolution}
            onChange={(e) =>
              change(
                e.target.value === 'auto'
                  ? automaticProfile(kind)
                  : { ...profile, resolution: Number(e.target.value) as Resolution, automatic: false },
              )
            }
          >
            <option value="auto">Авто</option>
            <option value="720">720p · HD</option>
            <option value="1080">1080p · Full HD</option>
            <option value="1440">1440p · QHD</option>
          </select>
        </label>
        <label>
          Плавность
          {/* Частота принадлежит уровню, а не живёт отдельно: «разрешение автоматическое,
              частота выбрана» обещало бы то, чего автоматика не умеет — она двигает и то,
              и другое одной ступенью. Поэтому в Авто список показывает Авто и не спорит. */}
          <select
            aria-label={label + ': частота кадров'}
            disabled={profile.automatic}
            value={profile.automatic ? 'auto' : profile.fps}
            onChange={(e) => change({ ...profile, fps: Number(e.target.value) as FrameRate })}
          >
            {profile.automatic && <option value="auto">Авто</option>}
            <option value="15">15 fps</option>
            <option value="30">30 fps</option>
            <option value="60">60 fps · плавнее</option>
          </select>
        </label>
      </div>
      {profile.automatic && (
        <p className="form-footnote">
          Авто выбирает и кадр, и частоту по тому, что выдерживает связь, — вплоть до 1440p · 60 fps, — и
          поднимает уровень, как только появляется запас.
        </p>
      )}
      {/*
        Настройки «показывать превью демонстрации» здесь больше нет — и не потому, что о ней
        забыли. Выключать её было незачем: в плитке у комнаты и так видно, что показ идёт, а
        размытый кадр раз в десять секунд лишь отвечает на вопрос «что там» — разобрать текст
        в нём нельзя. Лишний выключатель стоил объяснения на четыре строки, и объяснение это
        было длиннее самой вещи.
      */}
    </section>
  );
}
/**
 * Каким присылать чужое видео.
 *
 * Отдельно от того, каким я отдаю своё: это два разных решения, и раньше они были склеены —
 * выставил уровень камеры руками, и вместе с ним выключилась адаптация приёма. Незачем: в
 * плитке размером с визитку 1440p не видно никому, а на развёрнутой демонстрации он нужен
 * даже тому, кто сам отдаёт 720p.
 */
export function ReceptionFields({ mode, change }: { mode: Reception; change: (mode: Reception) => void }) {
  const options: { value: Reception; title: string; hint: string }[] = [
    {
      value: 'fit',
      title: 'По размеру окна',
      hint: 'Мелкой плитке — мелкий поток, развёрнутой — лучший, что отдаёт собеседник.',
    },
    {
      value: 'best',
      title: 'Всегда максимум',
      hint: 'Лучший слой даже в мелкой плитке. Больше трафика и нагрузки на приём.',
    },
  ];
  return (
    <section className="quality-section" aria-label="Качество приёма">
      <h3>
        <MonitorDown size={19} />
        Что присылать мне
      </h3>
      <div role="radiogroup" aria-label="Качество приёма" className="network-modes">
        {options.map((option) => (
          <label className="check-setting" key={option.value}>
            <input
              type="radio"
              name="reception-mode"
              checked={mode === option.value}
              onChange={() => change(option.value)}
            />
            <span>
              {option.title}
              <small>{option.hint}</small>
            </span>
          </label>
        ))}
      </div>
      <p className="form-footnote">
        Выше того, что отдаёт собеседник, не станет: если он выбрал 720p, максимум — его 720p. Смена
        применяется сразу.
      </p>
    </section>
  );
}
export function AudioFields({
  audio,
  change,
  meeting,
}: {
  audio: AudioPreferences;
  change: (value: AudioPreferences) => void;
  meeting?: Meeting | null;
}) {
  const level = useMicLevel(meeting);
  const constraints = navigator.mediaDevices?.getSupportedConstraints() as
    (MediaTrackSupportedConstraints & { voiceIsolation?: boolean }) | undefined;
  return (
    <section className="audio-settings" aria-label="Обработка микрофона">
      <h3>
        <Mic size={19} /> Голос и микрофон
      </h3>
      <label>
        Подавление шума
        <select
          value={audio.suppression}
          onChange={(e) =>
            change({ ...audio, suppression: e.target.value as AudioPreferences['suppression'] })
          }
        >
          <option value="browser">Стандартное</option>
          <option value="rnnoise" disabled={!('AudioWorkletNode' in window)}>
            RNNoise · усиленное, на устройстве
          </option>
          <option value="voice" disabled={!constraints?.voiceIsolation}>
            Изоляция голоса · системная
          </option>
          <option value="off">Выключено · исходный звук</option>
        </select>
      </label>
      <p className="form-footnote">
        Стандартное подходит для обычного разговора. RNNoise помогает убрать вентилятор и клавиатуру, но
        использует больше ресурсов. Для передачи музыки выберите исходный звук.
      </p>
      <label className="check-setting">
        <input
          type="checkbox"
          checked={audio.echoCancellation}
          onChange={(e) => change({ ...audio, echoCancellation: e.target.checked })}
        />
        <span>
          Подавление эха<small>Помогает при разговоре через динамики.</small>
        </span>
      </label>
      <label className="check-setting">
        <input
          type="checkbox"
          checked={audio.autoGainControl}
          onChange={(e) => change({ ...audio, autoGainControl: e.target.checked })}
        />
        <span>
          Автоматический уровень микрофона<small>Выравнивает тихий и громкий голос.</small>
        </span>
      </label>
      {/* Under automatic level the browser owns the gain, so offering a slider that changes
          nothing would be a lie. It stays visible to show what the setting took over. */}
      <label className="gain-setting" data-disabled={audio.autoGainControl}>
        Уровень передачи · {audio.autoGainControl ? 'автоматический' : `${Math.round(audio.gain * 100)}%`}
        <Slider
          min={0}
          max={200}
          step={1}
          disabled={audio.autoGainControl}
          value={Math.round(audio.gain * 100)}
          aria-label="Уровень передачи микрофона"
          onChange={(e) => change({ ...audio, gain: Number(e.target.value) / 100 })}
        />
      </label>
      {meeting && (
        <label className="gain-setting mic-live-level">
          Сейчас вас слышно так
          <meter
            min="0"
            max="100"
            low={15}
            high={90}
            optimum={60}
            value={level}
            aria-label="Текущий уровень микрофона"
          />
          <small>Говорите — полоса должна двигаться. Изменения применяются к встрече сразу.</small>
        </label>
      )}
    </section>
  );
}
/**
 * Notification sounds belong next to the other sound settings, not on the profile page where
 * they used to sit between a picture and a music token. What each cue means is written down
 * here because the cues are deliberately short: hearing one is faster than reading, but only
 * once you know what it was.
 */
export function SoundFields({ enabled, change }: { enabled: boolean; change: (enabled: boolean) => void }) {
  const demo = useMemo(() => new NotificationSounds(), []);
  return (
    <section className="audio-settings" aria-label="Звуки уведомлений">
      <h3>
        <Bell size={19} /> Звуки уведомлений
      </h3>
      <label className="check-setting">
        <input type="checkbox" checked={enabled} onChange={(e) => change(e.target.checked)} />
        <span>
          Сообщать звуком о том, что происходит во встрече
          <small>
            Вход и выход каждого участника, запрос на вход, новое сообщение в чате, ваш собственный вход и
            выход, включение и выключение вашего микрофона.
          </small>
        </span>
      </label>
      <div className="sound-samples">
        {(
          [
            ['self-join', 'Ваш вход'],
            ['join', 'Кто-то вошёл'],
            ['leave', 'Кто-то вышел'],
            ['knock', 'Просятся войти'],
            ['message', 'Сообщение в чате'],
            ['screen', 'Начался показ экрана'],
            ['mic-on', 'Микрофон включён'],
            ['mic-off', 'Микрофон выключен'],
          ] as const
        ).map(([cue, title]) => (
          <button
            key={cue}
            type="button"
            className="button ghost"
            disabled={!enabled}
            onClick={() => {
              ensureNotificationAudio();
              demo.play(cue);
            }}
          >
            <Play size={14} /> {title}
          </button>
        ))}
      </div>
      <p className="form-footnote">
        Звук выхода звучит и при закрытии приложения: сначала выход из встречи, потом окно.
      </p>
    </section>
  );
}

/**
 * Which server this client is talking to — a different question from who you are on it, which
 * is why it is no longer mixed into the profile page. Changing it ends the visit: favourites,
 * name and devices belong to a server and do not travel.
 */
function ConnectionFields({
  showPing,
  change,
  inCall,
}: {
  showPing: boolean;
  change: (showPing: boolean) => void;
  inCall: boolean;
}) {
  const desktop = !!window.chrome?.webview;
  const current = useStore(session);
  const here = currentServerUrl();
  const [saved, setSaved] = useState(thisServer);
  return (
    <section className="audio-settings" aria-label="Сервер">
      <h3>
        <Server size={19} /> Сервер
      </h3>
      <div className="connection-current">
        <strong>{current?.name || serverLabel(saved)}</strong>
        <small>{new URL(here).host}</small>
      </div>
      <label className="check-setting">
        <input
          type="checkbox"
          checked={saved.autoConnect}
          onChange={(e) => {
            setSaved(rememberServer({ autoConnect: e.target.checked }));
            // In the application the address list is native, so this switch is only true if
            // the shell hears about it — otherwise it would be a checkbox that does nothing.
            notifyDesktop('server.autoconnect', { autoConnect: e.target.checked });
          }}
        />
        <span>
          Подключаться автоматически при запуске
          <small>Иначе Cord будет ждать нажатия «Подключиться» на экране подключения.</small>
        </span>
      </label>
      <div className="check-actions">
        <button
          className="button secondary"
          disabled={inCall}
          title={inCall ? 'Сначала выйдите из встречи' : undefined}
          onClick={() => (desktop ? notifyDesktop('servers.open') : disconnect())}
        >
          <Plug size={16} /> {desktop ? 'Сменить сервер' : 'Отключиться'}
        </button>
        {!!saved.password && (
          <button className="button ghost" onClick={() => setSaved(rememberServer({ password: '' }))}>
            Забыть пароль
          </button>
        )}
      </div>
      <p className="form-footnote connection-note">
        {desktop
          ? 'Список серверов — в приложении: оно может обратиться к любому адресу. Имя, избранное и устройства сохраняются отдельно для каждого сервера.'
          : 'В браузере сервер один — тот, который отдал эту страницу: обращаться к другому адресу отсюда нельзя. Несколько серверов держит приложение для Windows.'}
      </p>
      <label className="check-setting">
        <input type="checkbox" checked={showPing} onChange={(e) => change(e.target.checked)} />
        <span>
          Показывать задержку / PING
          <small>Время ответа сервера на главной и управляющего канала во встрече.</small>
        </span>
      </label>
    </section>
  );
}

/**
 * Сколько звука держать про запас, прежде чем его услышат.
 *
 * Запас — единственное, что вообще способно пережить скачок задержки: пакеты, пришедшие с
 * опозданием, ещё можно проиграть, если их было куда положить. Поэтому «Авто» не означает
 * «как раньше»: раньше запас просили нулевой, и переживать всплеск было нечем.
 *
 * Раздел назывался «Плохая связь» и стоял на виду, рядом с адресом сервера. Три строки
 * «Автоматически / Минимальная задержка / Максимальная устойчивость» читались как выбор
 * качества — и вопрос «зачем это, если качество я уже выставил» был совершенно законным.
 * Настройка не трогает ни кадр, ни частоту, ни кодек; она про рывки звука, и живёт теперь
 * там же, где остальной звук, — под «Дополнительно», потому что по умолчанию её не трогают.
 */
function PlayoutFields({
  mode,
  change,
  link,
}: {
  mode: NetworkMode;
  change: (mode: NetworkMode) => void;
  link?: LinkState;
}) {
  const options: { value: NetworkMode; title: string; hint: string }[] = [
    {
      value: 'auto',
      title: 'Автоматически',
      hint: 'Запас растёт, когда связь начинает рваться, и снижается, когда всё ровно.',
    },
    {
      value: 'low-latency',
      title: 'Минимальная задержка',
      hint: 'Отвечать быстрее ценой того, что всплеск пинга будет слышен.',
    },
    {
      value: 'stable',
      title: 'Максимальная устойчивость',
      hint: 'Держать связь непрерывной даже на плохом канале. Голос заметно отстанет.',
    },
  ];
  return (
    <details className="advanced-settings">
      <summary>
        <Waves size={17} /> Дополнительно · запас буфера приёма
      </summary>
      <section aria-label="Запас буфера приёма">
        <p className="form-footnote">
          На чёткость картинки не влияет — только на то, как звук переживает скачки задержки. Качество видео
          целиком задаётся на вкладке «Видео».
        </p>
        <div role="radiogroup" aria-label="Запас буфера приёма" className="network-modes">
          {options.map((option) => (
            <label className="check-setting" key={option.value}>
              <input
                type="radio"
                name="network-mode"
                checked={mode === option.value}
                onChange={() => change(option.value)}
              />
              <span>
                {option.title}
                <small>{option.hint}</small>
              </span>
            </label>
          ))}
        </div>
        <p className="form-footnote">
          Музыка и звук демонстрации всегда получают больший запас, чем разговор: их никто не перебивает, и
          непрерывность для них важнее отзывчивости.
        </p>
        {link && link.path !== 'unknown' && (
          <p className="form-footnote" role="status">
            Сейчас: {pathName(link.path)} · {gradeName(link.grade)}
            {link.rttMs !== null && ` · оборот ${Math.round(link.rttMs)} мс`}
            {link.ordered &&
              '. Через TCP потерянный пакет переспрашивается, и всё пришедшее следом ждёт его. Запас поднят автоматически; если это повторяется, стоит проверить, пропускает ли сеть UDP.'}
          </p>
        )}
      </section>
    </details>
  );
}

function HotkeyField({ value, change }: { value: Hotkey | null; change: (key: Hotkey | null) => void }) {
  const [recording, setRecording] = useState(false);
  const nativeStatus = useStore(desktopHotkeyStatus);
  useEffect(() => {
    if (recording) notifyDesktop('hotkey.configure', { hotkey: null });
    return () => {
      if (recording) notifyDesktop('hotkey.configure', { hotkey: value });
    };
  }, [recording, value]);
  return (
    <section className="hotkey-settings">
      <h3>Включить / выключить микрофон</h3>
      <button
        className="hotkey-recorder button secondary"
        data-hotkey-recorder
        aria-label="Назначить сочетание микрофона"
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.code === 'Escape') {
            setRecording(false);
            return;
          }
          const next = hotkeyFromEvent(e.nativeEvent);
          if (next) {
            change(next);
            setRecording(false);
          }
        }}
      >
        {recording ? 'Нажмите сочетание… Esc — отмена' : hotkeyLabel(value)}
      </button>
      <div className="check-actions">
        <button className="button ghost" onClick={() => change({ ...defaultMicHotkey })}>
          По умолчанию
        </button>
        <button className="button ghost" onClick={() => change(null)}>
          Отключить сочетание
        </button>
      </div>
      {window.chrome?.webview && nativeStatus && (
        <p role="status" className="form-footnote">
          {nativeStatus}
        </p>
      )}
      <p className="form-footnote">
        В браузере сочетание работает в открытой вкладке встречи и не мешает вводу текста. В приложении
        Windows сочетания с Ctrl или Alt могут работать и поверх других программ.
      </p>
    </section>
  );
}
/**
 * Light, dark or whatever the system says.
 *
 * The application used to keep this in a dialog of its own, beside a copy of the name and the
 * sound switch — a second, smaller settings screen that knew less than this one. Appearance is
 * the last thing that lived only there, so it lives here now, and the shell follows the page.
 */
function AppearanceFields({ theme, setTheme }: { theme: Theme; setTheme: (theme: Theme) => void }) {
  return (
    <section className="audio-settings" aria-label="Оформление">
      <h3>
        <Palette size={19} /> Оформление
      </h3>
      <label>
        Тема
        <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
          <option value="system">Как в системе</option>
          <option value="light">Светлая</option>
          <option value="dark">Тёмная</option>
        </select>
      </label>
      <p className="form-footnote">
        Выбор сохраняется на этом устройстве и применяется сразу — и к окну приложения тоже.
      </p>
    </section>
  );
}
export function Settings({
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
  /** Which section to land on. The host asks for one when it opens these from the sidebar. */
  section?: string;
  theme?: Theme;
  setTheme?: (theme: Theme) => void;
}) {
  const saved = useMemo(() => new Store(readPreferences()), []);
  const offline = useMemo(() => new Store(unknownLink), []);
  const preferences = useStore(meeting?.media.preferences ?? saved);
  // Вне встречи о канале сказать нечего, но хук должен вызываться всегда.
  const link = useStore(meeting?.media.link ?? offline);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [tab, setTab] = useState(section ?? 'audio');
  useEffect(() => {
    if (open && section) setTab(section);
  }, [open, section]);
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
    // The room learns the picture when joining, so a change made during a meeting has to be
    // sent as well or it would only appear the next time.
    if (meeting && patch.avatar !== undefined)
      return meeting.command('profile.avatar', patch.avatar).then(() => undefined);
    return Promise.resolve();
  };
  useEffect(() => {
    if (!open) return;
    if (!meeting) saved.set(readPreferences());
    let active = true;
    const refresh = () =>
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((list) => {
          if (active) setDevices(list);
        })
        .catch(() => {});
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
    };
  }, [open, meeting, saved]);
  const device = (kind: MediaDeviceKind) => {
    const key = kind === 'audioinput' ? 'microphone' : kind === 'videoinput' ? 'camera' : 'speaker';
    return (
      <label key={kind}>
        {kind === 'audioinput' ? 'Микрофон' : kind === 'videoinput' ? 'Камера' : 'Вывод звука'}
        <select
          value={preferences.devices[key] ?? ''}
          disabled={kind === 'audiooutput' && !('setSinkId' in HTMLMediaElement.prototype)}
          onChange={(e) => {
            if (meeting) void meeting.media.switchDevice(kind, e.target.value);
            else change({ devices: { ...preferences.devices, [key]: e.target.value } });
          }}
        >
          <option value="">По умолчанию</option>
          {devices
            .filter((d) => d.kind === kind && d.deviceId)
            .map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Устройство ${i + 1}`}
              </option>
            ))}
        </select>
      </label>
    );
  };
  return (
    <Modal
      wide
      open={open}
      onOpenChange={onOpenChange}
      title="Настроить под себя"
      description="Настройки сохраняются на этом устройстве."
    >
      <Tabs.Root value={tab} onValueChange={(value) => setTab(String(value))} className="settings-tabs">
        <Tabs.List className="settings-navigation" aria-label="Разделы настроек">
          <Tabs.Tab value="audio">
            <Mic size={17} /> Звук
          </Tabs.Tab>
          <Tabs.Tab value="video">
            <Camera size={17} /> Видео
          </Tabs.Tab>
          <Tabs.Tab value="profile">
            <User size={17} /> Профиль
          </Tabs.Tab>
          <Tabs.Tab value="accounts">
            <KeyRound size={17} /> Аккаунты
          </Tabs.Tab>
          <Tabs.Tab value="connection">
            <Server size={17} /> Подключение
          </Tabs.Tab>
          <Tabs.Tab value="hotkeys">
            <Keyboard size={17} /> Клавиши
          </Tabs.Tab>
          <Tabs.Tab value="about">
            <Info size={17} /> О программе
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="audio" className="settings-form">
          {device('audioinput')}
          {device('audiooutput')}
          <AudioFields
            audio={preferences.audio}
            meeting={meeting}
            change={(audio) => {
              if (meeting) void meeting.media.setAudioSettings(audio);
              else change({ audio });
            }}
          />
          <SoundFields
            enabled={preferences.notificationSounds}
            change={(notificationSounds) => change({ notificationSounds })}
          />
          <PlayoutFields mode={preferences.network} link={link} change={(network) => change({ network })} />
          {open && <DeviceCheck preferences={preferences} />}
        </Tabs.Panel>
        <Tabs.Panel value="video" className="settings-form">
          {device('videoinput')}
          <QualityFields
            kind="camera"
            profile={preferences.camera}
            change={(camera) => {
              if (meeting) void meeting.media.setCameraProfile(camera);
              else change({ camera });
            }}
          />
          <QualityFields
            kind="screen"
            profile={preferences.screen}
            change={(screen) => {
              if (meeting) void meeting.media.setProfile(screen);
              else change({ screen });
            }}
          />
          <ReceptionFields
            mode={preferences.reception}
            change={(reception) => {
              if (meeting) void meeting.media.setReception(reception);
              else change({ reception });
            }}
          />
          {open && <DeviceCheck preferences={preferences} />}
        </Tabs.Panel>
        <Tabs.Panel value="profile" className="settings-form">
          <label>
            Имя по умолчанию
            <input
              maxLength={40}
              value={preferences.name}
              autoComplete="nickname"
              placeholder="Как к вам обращаться?"
              onChange={(e) => change({ name: e.target.value })}
            />
          </label>
          <p className="form-footnote">
            Это имя будет подставляться при следующем входе во встречу. Его можно изменить перед подключением.
          </p>
          <AvatarPicker preferences={preferences} change={change} />
          <label className="check-setting">
            <input
              type="checkbox"
              checked={preferences.showIntegrationPanel}
              onChange={(e) => change({ showIntegrationPanel: e.target.checked })}
            />
            <span>Показывать активных ботов справа от встречи</span>
          </label>
          {theme && setTheme && <AppearanceFields theme={theme} setTheme={setTheme} />}
        </Tabs.Panel>
        <Tabs.Panel value="accounts" className="settings-form">
          <AccountsTab preferences={preferences} change={change} />
        </Tabs.Panel>
        <Tabs.Panel value="connection" className="settings-form">
          <ConnectionFields
            showPing={preferences.showPing}
            change={(showPing) => change({ showPing })}
            inCall={!!meeting && !meeting.ended.get()}
          />
        </Tabs.Panel>
        <Tabs.Panel value="hotkeys" className="settings-form">
          <HotkeyField value={preferences.micHotkey} change={(micHotkey) => change({ micHotkey })} />
        </Tabs.Panel>
        <Tabs.Panel value="about" className="settings-form">
          {open && tab === 'about' && <AboutFields />}
        </Tabs.Panel>
      </Tabs.Root>
    </Modal>
  );
}
