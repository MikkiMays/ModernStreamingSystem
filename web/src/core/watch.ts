import type { Watch } from '../api/types';
import type { ProviderId } from './cinema';

/**
 * Совместный просмотр: что открыто в комнате и где оно должно играть прямо сейчас.
 *
 * ПОЧЕМУ ЯКОРЬ, А НЕ ПОТОК ПОЗИЦИЙ. Комната хранит одну пару чисел: позицию и момент по часам
 * сервера, в который она была верна ({@link Watch}). Сколько прошло с тех пор, каждый считает
 * сам — поэтому в комнату ничего не шлётся, пока никто ничего не нажимает, а опоздавший и
 * переподключившийся попадают ровно в то же место, не спрашивая никого отдельно. Секунда сети
 * тут стоит секунды рассинхрона, и только в момент нажатия; ежесекундная рассылка позиций
 * стоила бы того же самого, но постоянно.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Живой эфир позиции не имеет: у Twitch каждый смотрит собственный край
 * трансляции, и догонять там нечего — синхронизируется только то, **что** открыто. Попытка
 * «подтянуть» живой поток перемоткой даёт бесконечную буферизацию.
 */
// `Watch['provider']` и раньше был этим же самым союзом: `Watch` его лишь наследовал у
// реестра площадок ({@link ProviderId}), а здесь называет своим именем. Явный алиас читается
// без захода в `api/types.ts`, и остаётся верным сам собой, когда реестр отрастит площадку.
export type WatchProvider = ProviderId;
export type WatchKind = Watch['kind'];

/** Где ролик должен быть сейчас, по часам сервера. */
export function targetPosition(watch: Watch, serverNow: number): number {
  const elapsed = watch.paused ? 0 : Math.max(0, serverNow - watch.anchorAt);
  return Math.max(0, watch.positionMs + elapsed);
}

/**
 * Свой ролик кончился, и комната тоже дошла до конца: последний кадр — это и есть её секунда.
 *
 * Длины ролика комната не знает, и её цель идёт дальше конца. Раньше это читалось как отставание:
 * `play()` начинал досмотренный ролик заново (так его понимает браузер), проверка отправляла его
 * в конец — и так по кругу, а подпись всё это время говорила «Догоняем комнату…».
 */
export function finished(input: {
  watch: Watch;
  serverNow: number;
  localMs: number;
  ended: boolean;
}): boolean {
  const { watch, serverNow, localMs, ended } = input;
  return ended && !watch.paused && targetPosition(watch, serverNow) >= localMs - DRIFT_LIMIT;
}

/**
 * Три порога вместо одного — и это главное про синхронность.
 *
 * Раньше был один: разошлись больше чем на полторы секунды — перемотать. Перемотка стоит
 * чёрного кадра и провала звука у всех, кого она коснулась, поэтому порог держали высоким, и
 * жить с секундой расхождения приходилось постоянно: у друга уже сказали, у тебя ещё нет.
 *
 * Теперь расхождение до {@link DRIFT_LIMIT} не трогают вовсе (шевелиться тут дороже, чем
 * отставать), от него и до {@link JUMP_LIMIT} — **подтягивают скоростью**: пять процентов к
 * скорости воспроизведения незаметны на слух, зато полсекунды разницы уходят за десять секунд
 * без единого разрыва. И только разрыв больше {@link JUMP_LIMIT} — настоящая перемотка: это
 * уже не расхождение, а другое место в фильме.
 */
export const DRIFT_LIMIT = 300;
export const JUMP_LIMIT = 2500;
/** Разошлись настолько, что это видно человеку, а не только счётчику. */
export const VISIBLE_DRIFT = 1200;
/** На сколько разгоняться и притормаживать, догоняя. Больше — слышно, меньше — слишком долго. */
export const NUDGE = 0.05;
/** Догнали: возвращаем обычную скорость, не дожидаясь нуля, иначе она дребезжит. */
const SETTLED = 120;
/**
 * Догоняя перемоткой, целимся чуть вперёд: пока перемотка доедет и плеер добуферизует, уйдёт
 * ещё несколько долей секунды, и приземление ровно в цель означает снова отставать.
 */
const CATCH_UP_LEAD = 400;
/**
 * Сколько подтяжке дают, чтобы показать, что она тянет.
 *
 * Скорость — это просьба, а не гарантия: устройство, которому 1080p на 1,05 не по силам, теряет
 * кадры и идёт почти в реальном времени (задача 9: 1,003 при 5 % — полторы секунды отставания
 * ушли бы так за восемь минут). Поэтому подтяжка под присмотром: если за это время расхождение не
 * сократилось хотя бы на половину обещанного (5 % — это 250 мс за пять секунд), её сменяет
 * перемотка. Одна перемотка у одного отставшего дешевле минут рассинхрона и рваной картинки.
 */
export const NUDGE_PATIENCE = 5000;

export type Correction =
  | { action: 'none' }
  /** Включиться; с `positionMs` — сперва встать туда: на паузе перемотка ничего не рвёт. */
  | { action: 'play'; positionMs?: number }
  | { action: 'pause'; positionMs: number }
  | { action: 'seek'; positionMs: number }
  | { action: 'rate'; rate: number };

/** Окно наблюдения за подтяжкой: с какого момента (свои часы, мс) и с какого расхождения, мс. */
export interface CatchUp {
  since: number;
  driftMs: number;
}

/**
 * Тянет ли подтяжка ({@link NUDGE_PATIENCE}): следующее окно наблюдения и вердикт.
 *
 * `nudging` — скорость сейчас не обычная, и играем и мы, и комната. Окно открывается с первой
 * такой проверки и каждые {@link NUDGE_PATIENCE} мс сдаёт отчёт: отыграно не меньше половины
 * обещанного — открывается заново с нового места, меньше — `stalled`. Проскочили цель — это не
 * застревание, окно начинается заново уже с другой стороны.
 */
export function catchUp(
  previous: CatchUp | null,
  input: { now: number; driftMs: number; nudging: boolean },
): { next: CatchUp | null; stalled: boolean } {
  const { now, driftMs, nudging } = input;
  if (!nudging) return { next: null, stalled: false };
  const fresh = { next: { since: now, driftMs }, stalled: false };
  if (!previous || Math.sign(previous.driftMs) !== Math.sign(driftMs)) return fresh;
  const elapsed = now - previous.since;
  if (elapsed < NUDGE_PATIENCE) return { next: previous, stalled: false };
  const gained = Math.abs(previous.driftMs) - Math.abs(driftMs);
  return gained < (NUDGE * elapsed) / 2 ? { next: null, stalled: true } : fresh;
}

/**
 * Что сделать со своим плеером, чтобы оказаться там же, где комната. Ответ считается от
 * состояния комнаты, а не от чужих сообщений: своё решение принимает каждый сам и одинаково.
 */
export function correction(input: {
  watch: Watch;
  /**
   * Эфир это или произведение с началом и концом.
   *
   * Отдельно от {@link Watch.kind}, потому что одно не сводится к другому: запись трансляции
   * Twitch приходит как `video` — её можно ставить на паузу, — но пока эфир не кончился,
   * площадка отдаёт её живым потоком без общей позиции. Считать такую запись роликом значило
   * бы перематывать её к секунде, которой в потоке ещё нет.
   */
  live?: boolean;
  serverNow: number;
  /** Позиция своего плеера, мс. `null` — плеер ещё не отвечает. */
  localMs: number | null;
  playing: boolean;
  /**
   * Свой ролик кончился (`<video>.ended`).
   *
   * Отдельно от `playing`, потому что «не играет» тут не значит «пора включить»: `play()` у
   * кончившегося ролика по стандарту — перемотка в начало ({@link finished}). На стенде так оба
   * браузера и крутили «первые две секунды — конец» каждые четыре секунды.
   */
  ended?: boolean;
  /** Своя скорость воспроизведения: подтяжка помнится между проверками, а не начинается с нуля. */
  rate?: number;
  /** Подтяжка не тянет ({@link catchUp}): вместо неё — перемотка. */
  stalled?: boolean;
}): Correction {
  const { watch, serverNow, localMs, playing } = input;
  const rate = input.rate ?? 1;
  const ordinary = (): Correction => (rate === 1 ? { action: 'none' } : { action: 'rate', rate: 1 });
  /*
    Живой эфир не двигают: общей позиции у него нет, а перемотка к «краю» — это бесконечная
    буферизация. Общим остаётся только то, какой канал открыт.

    Но играть его всё-таки нужно, и это единственное, что здесь решается. Пока этой строки не
    было, эфир вёл себя загадочно: сегменты шли, окно росло, картинка стояла — потому что
    команду `play()` не давал никто. У ролика её даёт комната, а у эфира комнате нечего
    сказать: каждый смотрит свой край трансляции.
  */
  if (input.live || watch.kind !== 'video') return playing ? ordinary() : { action: 'play' };
  const target = targetPosition(watch, serverNow);
  // Отставшего догоняем с запасом: пока перемотка доедет, комната уйдёт ещё немного вперёд.
  const reach = (drift: number) => (drift < 0 ? target + CATCH_UP_LEAD : target);
  if (watch.paused) {
    if (playing) return { action: 'pause', positionMs: target };
    if (localMs !== null && Math.abs(localMs - target) > JUMP_LIMIT)
      return { action: 'seek', positionMs: target };
    return ordinary();
  }
  if (localMs !== null && finished({ watch, serverNow, localMs, ended: !!input.ended })) return ordinary();
  if (!playing) {
    /*
      Включаемся с секунды комнаты, а не с места, где стояли.

      Пуск доходит до зрителя не сразу: сеть, затем ближайшая проверка — на стенде второй
      включался на 1,9 с позже комнаты и дальше минуту догонял её скоростью. Перемотка перед
      пуском ничего не рвёт — кадр и так стоит, а звука ещё нет, — поэтому здесь встаём точно.
      Разницу в пределах «не трогать» не трогаем и здесь: прыжок ради неё дороже её самой.
    */
    if (localMs !== null && Math.abs(localMs - target) > DRIFT_LIMIT)
      return { action: 'play', positionMs: reach(localMs - target) };
    return { action: 'play' };
  }
  if (localMs === null) return { action: 'none' };
  const drift = localMs - target;
  if (Math.abs(drift) > JUMP_LIMIT || (input.stalled && Math.abs(drift) > DRIFT_LIMIT))
    return { action: 'seek', positionMs: reach(drift) };
  // Подтяжка не тянет, но и расхождение уже в пределах «не трогать»: без толку разгонять дальше.
  if (input.stalled) return ordinary();
  if (Math.abs(drift) > DRIFT_LIMIT) {
    const wanted = Number((drift < 0 ? 1 + NUDGE : 1 - NUDGE).toFixed(3));
    return rate === wanted ? { action: 'none' } : { action: 'rate', rate: wanted };
  }
  // Между «догнали» и «пора подтягивать» скорость не меняется ни в ту, ни в другую сторону:
  // без этой полосы плеер щёлкал бы туда-сюда каждую секунду у самого порога.
  if (Math.abs(drift) <= SETTLED) return ordinary();
  return { action: 'none' };
}
