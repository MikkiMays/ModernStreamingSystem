/**
 * Когда показ можно открывать зрителям.
 *
 * ЗАЧЕМ (T48). Сразу после публикации браузер разгоняет полосу, и верхний слой первые секунды
 * кодируется мельче целевого: зритель, открывший показ в эту секунду, видит кашу и думает на
 * качество. По решению 4 архитектора «кадр целевого качества» фиксирует **отправитель** — он
 * один знает, что кодирует, — командой `screen.started`; до неё у всех на плитке «Готовится
 * показ…». Зрителю со слабым каналом верхний слой может не прийти никогда, поэтому ждать его
 * у каждого зрителя нельзя: показ открылся бы не у всех.
 *
 * Ждём не бесконечно: окно разгона (`capabilities.quality.settleMs`) кончилось — открываем, что
 * есть. Разгон, который не уложился в окно, — уже свойство канала, а не старта, и прятать показ
 * дальше значит прятать его насовсем.
 */
export interface ScreenSample {
  width: number;
  height: number;
  framesEncoded: number;
}
export type Readiness = 'waiting' | 'ready' | 'expired';

/** Небольшой недобор — выравнивание кодировщика, а не разгон: 1072 вместо 1080 — это готово. */
const TOLERANCE = 0.95;

export class ScreenReadiness {
  constructor(
    private readonly target: { width: number; height: number },
    private readonly windowMs: number,
    private readonly startedAt: number,
  ) {}

  observe(sample: ScreenSample | null, now: number): Readiness {
    if (
      sample &&
      sample.framesEncoded > 0 &&
      sample.width >= this.target.width * TOLERANCE &&
      sample.height >= this.target.height * TOLERANCE
    )
      return 'ready';
    return now - this.startedAt >= this.windowMs ? 'expired' : 'waiting';
  }
}

/** Самый крупный из кодируемых слоёв: именно он и есть «что отдаётся». */
export function readScreenSample(report: RTCStatsReport): ScreenSample | null {
  let found: ScreenSample | null = null;
  report.forEach((stat) => {
    if (stat.type !== 'outbound-rtp' || (stat.kind ?? stat.mediaType) !== 'video') return;
    const sample = {
      width: Number(stat.frameWidth ?? 0),
      height: Number(stat.frameHeight ?? 0),
      framesEncoded: Number(stat.framesEncoded ?? 0),
    };
    if (!found || sample.width > found.width) found = sample;
  });
  return found;
}
