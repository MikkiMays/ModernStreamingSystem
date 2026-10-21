import { hasFeature, invokeDesktop, isDesktop, notifyDesktop } from './desktop';

/**
 * Своё окно выбора источника показа в клиенте на Electron (T10, E01-B2, ADR 0001 §4.1).
 *
 * Как в Discord: человек выбирает экран или окно в окне Cord (E16), а не в браузерном диалоге.
 * Порядок: `invoke('capture.sources')` — экраны и окна с миниатюрами; выбор → `invoke('capture.select')`
 * с ответом; только потом `getDisplayMedia`, и оболочка отдаёт ровно выбранный источник. Выбор
 * живёт у оболочки 10 секунд и один запрос — без него она покажет своё окно выбора.
 *
 * Звук: «Со звуком системы» — весь звук компьютера (loopback, только Windows, флаг
 * `capture.system-audio`); звук отдельного приложения ждёт `cord-native`.
 */
export type CaptureAudio = 'none' | 'system';

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
  return { systemAudio: !Array.isArray(answer) && data.systemAudio === true, sources };
}

/** Экраны и окна от оболочки; не ответила — пустой список, окно скажет «не найдено». */
export async function listCaptureSources(): Promise<CaptureSources> {
  try {
    return parseCaptureSources(await invokeDesktop('capture.sources', {}));
  } catch {
    return { systemAudio: false, sources: [] };
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
