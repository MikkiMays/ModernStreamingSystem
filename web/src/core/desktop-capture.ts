import { t } from '../i18n';
import type { ScreenAudioEvent, ScreenAudioSource } from '../media/capture';
import { hasFeature, invokeDesktop, isDesktop, notifyDesktop, onDesktopEvent } from './desktop';

/**
 * Своё окно выбора источника показа в клиенте на Electron (T10, E01-B2, ADR 0001 §4.1).
 *
 * Как в Discord: человек выбирает экран или окно в окне Cord (E16), а не в браузерном диалоге.
 * Порядок: `invoke('capture.sources')` — экраны и окна с миниатюрами; выбор → `invoke('capture.select')`
 * с ответом; только потом `getDisplayMedia`, и оболочка отдаёт ровно выбранный источник. Выбор
 * живёт у оболочки 10 секунд и один запрос — без него она покажет своё окно выбора.
 *
 * Звук: «Звук системы» — весь звук компьютера (loopback Electron, только Windows, флаг
 * `capture.system-audio`), в него попадают и голоса встречи. «Звук приложения» (только у окна) и
 * «Система кроме Cord» — process loopback в `cord-native` (флаг `capture.app-audio`, E01-B3):
 * дорожка приходит не из `getDisplayMedia`, а отдельно — см. `desktopCaptureAudio`.
 */
export type CaptureAudio = 'none' | 'system' | 'app' | 'system-except-cord';

export interface CaptureSource {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** `data:image/…` или пустая строка. */
  thumbnail: string;
  icon: string;
}

export interface CaptureSources {
  systemAudio: boolean;
  /** Оболочка готова к звуку приложения сейчас (модуль жив), а не только при запуске. */
  appAudio: boolean;
  sources: CaptureSource[];
}

const SOURCE_ID = /^(screen|window):\d+:\d+$/;

/** Окно выбора показывает веб — только в оболочке v2, объявившей `capture`. */
export function desktopPicker(): boolean {
  return isDesktop() && hasFeature('capture');
}

/** «Со звуком системы» есть только там, где оболочка его объявила (Windows). */
export function systemAudioAvailable(): boolean {
  return hasFeature('capture.system-audio');
}

/**
 * Режимы звука в окне выбора — при флаге `capture.app-audio` и согласии оболочки в этом ответе
 * (модуль мог упасть после запуска). «Звук приложения» — только у окна: у экрана нет одного
 * приложения. `null` — режимов нет, окно показывает прежний выключатель звука системы.
 */
export function captureAudioModes(kind: CaptureSource['kind'], found: CaptureSources): CaptureAudio[] | null {
  if (!hasFeature('capture.app-audio') || !found.appAudio) return null;
  return [
    'none',
    ...(systemAudioAvailable() && found.systemAudio ? (['system'] as const) : []),
    ...(kind === 'window' ? (['app'] as const) : []),
    'system-except-cord',
  ];
}

function picture(value: unknown): string {
  return typeof value === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
    ? value
    : '';
}

/** Ответ оболочки без доверия: только известные id источников и картинки `data:image/`. */
export function parseCaptureSources(answer: unknown): CaptureSources {
  const data = answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  const list = Array.isArray(answer) ? answer : Array.isArray(data.sources) ? data.sources : [];
  const sources: CaptureSource[] = [];
  for (const item of list.slice(0, 100)) {
    if (!item || typeof item !== 'object') continue;
    const source = item as Record<string, unknown>;
    if (typeof source.id !== 'string' || !SOURCE_ID.test(source.id)) continue;
    sources.push({
      id: source.id,
      name: typeof source.name === 'string' ? source.name.slice(0, 80) : '',
      kind: source.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: picture(source.thumbnail),
      icon: picture(source.icon),
    });
  }
  const object = !Array.isArray(answer);
  return {
    systemAudio: object && data.systemAudio === true,
    appAudio: object && data.appAudio === true,
    sources,
  };
}

/** Экраны и окна от оболочки; не ответила — пустой список, окно скажет «не найдено». */
export async function listCaptureSources(): Promise<CaptureSources> {
  try {
    return parseCaptureSources(await invokeDesktop('capture.sources', {}));
  } catch {
    return { systemAudio: false, appAudio: false, sources: [] };
  }
}

/**
 * Передать выбор оболочке и дождаться ответа — до `getDisplayMedia`. Оболочка, где
 * `capture.select` ещё сообщение, получает его сообщением.
 */
export async function selectCaptureSource(id: string, audio: CaptureAudio): Promise<void> {
  try {
    await invokeDesktop('capture.select', { id, audio });
  } catch {
    notifyDesktop('capture.select', { id, audio });
  }
}

/** Элемент, через который preload отдаёт дорожку (`CAPTURE_AUDIO_ELEMENT` моста). */
const CAPTURE_AUDIO_ELEMENT = 'cord-desktop-capture-audio';

/**
 * Живая дорожка из скрытого `<audio>` preload. Передать `MediaStreamTrack` между мирами Chromium
 * не даёт, а DOM у них общий: preload кладёт поток в `srcObject`, страница берёт его оттуда.
 */
function captureAudioTrack(): MediaStreamTrack | null {
  const element = document.getElementById(CAPTURE_AUDIO_ELEMENT) as Partial<HTMLMediaElement> | null;
  const stream = element?.srcObject as Partial<MediaStream> | null | undefined;
  const track = stream?.getAudioTracks?.()[0];
  return track && track.readyState === 'live' ? track : null;
}

/** Причина отказа оболочки → короткая подсказка; показ при этом идёт без звука. */
function audioProblem(reason: unknown, started: boolean): string {
  if (reason === 'not-a-window') return t(($) => $.media.screen.audio.notWindow);
  if (reason === 'unavailable' || reason === 'native') return t(($) => $.media.screen.audio.unavailable);
  const text = typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 120) : '—';
  return started
    ? t(($) => $.media.screen.audio.stopped, { reason: text })
    : t(($) => $.media.screen.audio.failed, { reason: text });
}

/**
 * Звук показа от `cord-native` (E01-B3): для «Звук приложения» и «Система кроме Cord» — источник,
 * на который подписывается встреча; для остальных режимов своей дорожки нет — `undefined`.
 *
 * Оболочка шлёт `capture.audio {state, mode, reason?}`: `ready` — дорожка в элементе preload,
 * `failed` — показ без звука, `ended` — дорожки больше нет.
 *
 * ПРОШЛЫЙ ПОКАЗ. Новому подписчику preload сразу (микрозадачей) отдаёт последнее своё состояние, а
 * подписка идёт до `getDisplayMedia` — значит, это состояние прошлого показа. Отказ или конец,
 * пришедшие до первой макрозадачи после подписки, не считаются: события этого показа идут по IPC
 * после того, как оболочка отдаст экран, — заметно позже. Готовность проверяется по самому элементу:
 * без живой дорожки её нет.
 */
export function desktopCaptureAudio(mode: CaptureAudio): ScreenAudioSource | undefined {
  if (mode !== 'app' && mode !== 'system-except-cord') return undefined;
  return {
    watch(listener: (event: ScreenAudioEvent) => void) {
      let replay = true;
      let started = false;
      const timer = setTimeout(() => (replay = false), 0);
      const stop = onDesktopEvent('capture.audio', (data) => {
        if (typeof data.mode === 'string' && data.mode && data.mode !== mode) return;
        if (data.state === 'ready') {
          const track = captureAudioTrack();
          if (!track) return;
          started = true;
          listener({ state: 'ready', track });
          return;
        }
        if (replay) return;
        if (data.state === 'failed')
          listener({ state: 'failed', message: audioProblem(data.reason, started) });
        else if (data.state === 'ended') listener({ state: 'ended' });
        else return;
        started = false;
      });
      return () => {
        clearTimeout(timer);
        stop();
      };
    },
  };
}
