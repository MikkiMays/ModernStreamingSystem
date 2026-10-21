/**
 * Рекламные вставки, которые помечает сам поток (T17, «пропустить рекламу»).
 *
 * ЧТО СЧИТАЕТСЯ РЕКЛАМОЙ. Только то, что поток сам называет рекламой: `EXT-X-CUE-OUT` … `EXT-X-CUE-IN`
 * (и `EXT-X-SCTE35` с `CUE-OUT=YES`/`CUE-IN=YES`), `EXT-X-DATERANGE` с `SCTE35-OUT` или с классом
 * рекламы (`CLASS` со словом ad/ads/advert, `…stitched-ad`). Догадок по длине куска здесь нет: пропустить
 * кусок фильма для всей комнаты хуже, чем показать рекламу. Разрывы `DISCONTINUITY` с хостов рекламных
 * сетей помечает тем же `CUE-OUT`/`CUE-IN` прокси службы (`cinema/ads.py`) — браузер хостов сегментов
 * после прокси уже не видит, а разметку читает так же. Вставки-интерстишелы
 * (`com.apple.hls.interstitial`) — не отрезок основного потока, а отдельный ролик поверх него: их hls.js
 * просто не играет (`enableInterstitialPlayback: false` в `engines/hls.ts`), пропускать там нечего.
 *
 * ОТКУДА ТЕГИ. Прокси службы переписывает в плейлисте только адреса (`transport/playlists.py`), остальные
 * теги доходят до hls.js как есть, и он кладёт неизвестные в `fragment.tagList` (`['EXT-X-CUE-OUT',
 * '30']`, `['EXT-X-CUE-IN']`, `['EXT-X-DATERANGE', атрибуты]`) — у тега того фрагмента, перед которым он
 * стоит. Отсюда и место вставки на шкале `<video>`.
 */

/** Фрагмент списка HLS так, как его отдаёт hls.js (`LevelDetails.fragments`). */
export interface AdFragment {
  /** Начало на шкале `<video>`, секунды. */
  start: number;
  duration: number;
  /** `EXT-X-PROGRAM-DATE-TIME` фрагмента, миллисекунды; `null` — поток его не пишет. */
  programDateTime: number | null;
  tagList: readonly (readonly string[])[];
}

/** Отрезок рекламы на шкале `<video>`, секунды. */
export interface AdBreak {
  start: number;
  end: number;
}

/** Короче секунды — не вставка, а шум разметки; длиннее десяти минут — скорее ошибка, чем реклама. */
export const AD_MIN_S = 1;
export const AD_MAX_S = 600;

const AD_CLASS = /(^|[^a-z])(ad|ads|advert|advertisement|commercial)([^a-z]|$)|stitched-ad/i;
const INTERSTITIAL = /interstitial/i;

/** Атрибуты тега: `ID="a,b",DURATION=30` → `{ ID: 'a,b', DURATION: '30' }`. */
export function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  for (const match of text.matchAll(pattern)) {
    const value = match[2] ?? '';
    found[match[1]!.toUpperCase()] = value.startsWith('"') ? value.slice(1, -1) : value;
  }
  return found;
}

function seconds(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Длительность у `EXT-X-CUE-OUT`: `30`, `30.0` или `DURATION=30`. */
function cueDuration(value: string | undefined): number | null {
  if (!value) return null;
  const plain = seconds(value.trim());
  if (plain !== null) return plain;
  return seconds(attributes(value).DURATION);
}

/** Где на шкале `<video>` начинается `DATERANGE`: по датам, а без `PROGRAM-DATE-TIME` — у своего тега. */
function rangeStart(attrs: Record<string, string>, anchor: AdFragment): number {
  const date = Date.parse(attrs['START-DATE'] ?? '');
  if (anchor.programDateTime === null || !Number.isFinite(date)) return anchor.start;
  return anchor.start + (date - anchor.programDateTime) / 1000;
}

function rangeLength(attrs: Record<string, string>): { exact: number | null; planned: number | null } {
  const duration = seconds(attrs.DURATION);
  const start = Date.parse(attrs['START-DATE'] ?? '');
  const end = Date.parse(attrs['END-DATE'] ?? '');
  const between = Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 1000 : null;
  return { exact: duration ?? between, planned: seconds(attrs['PLANNED-DURATION']) };
}

/** Рекламные отрезки списка — по возрастанию, без наложений. */
export function adBreaks(fragments: readonly AdFragment[]): AdBreak[] {
  const found: AdBreak[] = [];
  let open: { start: number; planned: number | null } | null = null;
  const ranges = new Map<
    string,
    { start: number; exact: number | null; planned: number | null; ad: boolean }
  >();
  for (const fragment of fragments) {
    for (const [tag, value] of fragment.tagList) {
      const scte = tag === 'EXT-X-SCTE35' ? attributes(value ?? '') : null;
      if (tag === 'EXT-X-CUE-OUT' || scte?.['CUE-OUT']?.toUpperCase() === 'YES') {
        open ??= { start: fragment.start, planned: tag === 'EXT-X-CUE-OUT' ? cueDuration(value) : null };
      } else if (tag === 'EXT-X-CUE-IN' || scte?.['CUE-IN']?.toUpperCase() === 'YES') {
        if (open) found.push({ start: open.start, end: fragment.start });
        open = null;
      } else if (tag === 'EXT-X-DATERANGE' && value) {
        const attrs = attributes(value);
        const kind = attrs.CLASS ?? '';
        if (INTERSTITIAL.test(kind)) continue;
        const id = attrs.ID ?? `${fragment.start}`;
        const start = rangeStart(attrs, fragment);
        const length = rangeLength(attrs);
        const ad = 'SCTE35-OUT' in attrs || AD_CLASS.test(kind);
        const known = ranges.get(id);
        ranges.set(id, {
          start: known ? Math.min(known.start, start) : start,
          exact: length.exact ?? known?.exact ?? null,
          planned: length.planned ?? known?.planned ?? null,
          ad: ad || !!known?.ad,
        });
      }
    }
  }
  if (open && open.planned !== null) found.push({ start: open.start, end: open.start + open.planned });
  for (const range of ranges.values()) {
    const length = range.exact ?? range.planned;
    if (range.ad && length !== null) found.push({ start: range.start, end: range.start + length });
  }
  const sane = found
    .filter((entry) => entry.end - entry.start >= AD_MIN_S && entry.end - entry.start <= AD_MAX_S)
    .sort((a, b) => a.start - b.start);
  const merged: AdBreak[] = [];
  for (const entry of sane) {
    const last = merged.at(-1);
    if (last && entry.start <= last.end + 0.25) last.end = Math.max(last.end, entry.end);
    else merged.push({ ...entry });
  }
  return merged;
}

/** Отрезок рекламы, в котором стоит секунда `at`, — пока до его конца больше полусекунды. */
export function adAt(breaks: readonly AdBreak[], at: number): AdBreak | null {
  return breaks.find((entry) => at >= entry.start && at < entry.end - 0.5) ?? null;
}

/** Участник, как его видит очередь пропуска: номер, статус и бот ли это (`service`). */
interface Member {
  id: string;
  status: string;
  service?: string | null;
}

const PRESENT = new Set(['JOINING', 'CONNECTED', 'RECOVERING']);

/**
 * Место в очереди тех, кто пропускает рекламу за комнату: открывший — первым, остальные — по номеру.
 *
 * Пропуск — общая команда (`watch.seek`), и слать её всей комнате разом незачем: первый в очереди
 * шлёт сразу, следующий — если через полторы секунды комната всё ещё в рекламе (первый без права на
 * пульт, отстал или ушёл), и так дальше. Чьё право на пульт — знает только ядро (`you.can` есть лишь у
 * себя), поэтому очередь — из всех, кто здесь, а без права просто не шлют.
 */
export function skipRank(
  self: string,
  openedBy: string | null | undefined,
  people: readonly Member[],
): number {
  const here = people.filter((person) => PRESENT.has(person.status) && !person.service).map((p) => p.id);
  const others = here.filter((id) => id !== openedBy).sort();
  const line = openedBy && here.includes(openedBy) ? [openedBy, ...others] : others;
  const place = line.indexOf(self);
  return place < 0 ? line.length : place;
}

/** Шаг очереди пропуска, миллисекунды. */
export const SKIP_STEP_MS = 1500;
