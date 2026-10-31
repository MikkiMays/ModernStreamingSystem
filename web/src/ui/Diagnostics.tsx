import { useEffect, useId, useState, type ReactNode } from 'react';
import { ClipboardCopy, Headset, MessageSquareWarning, RotateCcw, Wifi } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { publicApi } from '../api/client';
import { callReportText, diagnosticsText } from '../core/support';
import { StatsSampler, type Sample } from '../media/diagnostics';
import { gradeName, pathName } from '../media/link-quality';
import { useStore } from './primitives';
import { Button, Dialog } from './kit';
import { DeviceCheck } from './DeviceCheck';
import './diagnostics.css';

/** Причины, которыми браузер объясняет ограничение передачи; незнакомую показываем как есть. */
const LIMITS = ['none', 'cpu', 'bandwidth', 'unknown'] as const;
type Limit = (typeof LIMITS)[number];
const isLimit = (value: string): value is Limit => (LIMITS as readonly string[]).includes(value);

/** Строка «подпись — значение» сводки: подпись слева приглушённо, значение справа. */
function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="diagnostics-metric">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Дорожка строкой для «Скопировать отчёт о звонке» (R29, MEDIA-DIAGNOSIS §8): вид, направление и
 * числа — без имени участника и адресов. Ключи по-английски, как у диагностики обращения.
 */
export function sampleLine(sample: Sample): string {
  const ms = (value: number | null) => (value === null ? 'n/a' : `${Math.round(value)} ms`);
  return [
    `track: ${sample.kind} ${sample.outbound ? 'send' : 'receive'}`,
    `${Math.round(sample.mbps * 1000)} kbps`,
    `loss ${sample.loss === null ? 'n/a' : `${sample.loss.toFixed(1)}%`}`,
    `rtt ${ms(sample.rttMs)}`,
    `buffer ${ms(sample.bufferMs)}`,
    ...(sample.kind === 'video'
      ? [`${sample.width}x${sample.height}@${sample.fps.toFixed(0)}`]
      : sample.outbound
        ? []
        : [`concealment ${sample.concealmentEvents}`, ...(sample.silentSource ? ['silent source'] : [])]),
    sample.codec,
  ].join(' · ');
}

/**
 * «Диагностика» встречи: проверка своих устройств, сеть, подробности каждой дорожки и «зависло».
 *
 * Окно набора (`Dialog`, слой 50), без подзаголовка (R47). Подробности аудио и видео — обычный
 * раздел, а не сворачиваемый `<details>` с системным ▼ (R48): прятать нечего, это и есть ответ на
 * «почему лагает». У принятого звука видно и тишину издателя, и пропуски, которые браузер заполнил
 * заглушкой (R09, R29), а «Скопировать отчёт о звонке» кладёт в буфер то, что просит поддержка, — без
 * имён и адресов. Разделы — карточками на токенах отступов (R29). Подвал: «Сообщить о проблеме» и
 * «Поддержка» закрывают диагностику и открывают поддержку (`onReport`, `onHelp`, R49, R79): окна
 * заменяют друг друга, а не ложатся стопкой.
 */
export default function Diagnostics({
  meeting,
  onClose,
  onHelp,
  onReport,
}: {
  meeting: Meeting;
  onClose: () => void;
  onHelp: () => void;
  onReport: () => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [samples, setSamples] = useState<(Sample & { name: string })[]>([]);
  const [network, setNetwork] = useState<{ running: boolean; times: number[]; failures: number }>({
    running: false,
    times: [],
    failures: 0,
  });
  const [targets, setTargets] = useState<ReturnType<Meeting['media']['playoutTargets']>>([]);
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null);
  const preferences = useStore(meeting.media.preferences);
  const media = useStore(meeting.media.state);
  const link = useStore(meeting.media.link);
  const control = useStore(meeting.control.state);
  // Паузы видео от SFU (R117): их причина — всегда наш собственный канал приёма, поэтому и сказать
  // о них место здесь, в «Сети», а не у собеседника.
  const pausedNow = useStore(meeting.media.videoPaused);
  // Задержка доски (R159): от штриха соседа до этого экрана, пока доска на сцене.
  const board = useStore(meeting.boardLatency);
  const pauses = useStore(meeting.media.videoPauseCount);
  useEffect(() => {
    let disposed = false;
    let busy = false;
    const sampler = new StatsSampler();
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      setTargets(meeting.media.playoutTargets());
      void Promise.all(
        meeting.media.tracks.get().map(async (tile) =>
          (await sampler.sample(tile.track).catch(() => [])).map((sample) => ({
            ...sample,
            name: tile.name,
          })),
        ),
      )
        .then((result) => {
          if (!disposed) setSamples(result.flat());
        })
        .finally(() => {
          busy = false;
        });
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [meeting]);
  const testNetwork = async () => {
    if (network.running) return;
    const times: number[] = [];
    let failures = 0;
    setNetwork({ running: true, times, failures });
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      try {
        await publicApi.capabilities();
        times.push(performance.now() - start);
      } catch {
        failures++;
      }
      setNetwork({ running: i < 4, times: [...times], failures });
    }
  };
  const copyReport = async () => {
    const text = [
      diagnosticsText(),
      callReportText(meeting.media.callReport()),
      ...targets.map((target) => `playout: ${target.kind} ${target.targetMs} ms`),
      ...(pauses ? [`video paused by sfu: ${pauses}`] : []),
      ...(board ? [`board latency: p50 ${board.p50} ms, p95 ${board.p95} ms (${board.count})`] : []),
      ...samples.map(sampleLine),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t(($) => $.diagnostics.title)}
      size="lg"
      className="diagnostics-dialog"
      footer={
        <>
          <Button size="sm" variant="quiet" icon={<MessageSquareWarning />} onClick={onReport}>
            {t(($) => $.diagnostics.report)}
          </Button>
          <Button size="sm" variant="quiet" icon={<Headset />} onClick={onHelp}>
            {t(($) => $.support.open)}
          </Button>
        </>
      }
    >
      <div className="diagnostics">
        <DeviceCheck preferences={preferences} />
        <section className="diagnostics-card" aria-labelledby={`${id}-network`}>
          <h3 className="diagnostics-card__title" id={`${id}-network`}>
            <Wifi aria-hidden="true" /> {t(($) => $.diagnostics.network)}
          </h3>
          <dl className="diagnostics-metrics">
            <Metric label={t(($) => $.diagnostics.media.label)}>
              {media.status === 'connected'
                ? t(($) => $.diagnostics.media.connected)
                : media.status === 'recovering'
                  ? t(($) => $.diagnostics.media.recovering)
                  : t(($) => $.diagnostics.media.disconnected)}
            </Metric>
            <Metric label={t(($) => $.diagnostics.control.label)}>
              {control === 'connected'
                ? t(($) => $.diagnostics.control.connected)
                : control === 'closed'
                  ? t(($) => $.diagnostics.control.closed)
                  : t(($) => $.diagnostics.control.connecting)}
            </Metric>
            <Metric label={t(($) => $.diagnostics.quality.label)}>
              {t(($) => $.diagnostics.quality.values[media.quality])}
            </Metric>
            <Metric label={t(($) => $.diagnostics.path)}>
              {pathName(t, link.path)} · {gradeName(t, link.grade)}
            </Metric>
            <Metric label={t(($) => $.diagnostics.jitter.label)}>
              {link.jitterMs === null
                ? t(($) => $.diagnostics.noData)
                : t(($) => $.diagnostics.jitter.value, { ms: Math.round(link.jitterMs) })}
            </Metric>
            <Metric label={t(($) => $.diagnostics.buffer.label)}>
              {targets.length
                ? targets
                    .map((target) =>
                      t(($) => $.diagnostics.buffer.target, {
                        kind: t(($) => $.diagnostics.buffer.kinds[target.kind]),
                        ms: target.targetMs,
                      }),
                    )
                    .join(' · ')
                : t(($) => $.diagnostics.buffer.none)}
            </Metric>
            {board && (
              <Metric label={t(($) => $.diagnostics.board.label)}>
                {t(($) => $.diagnostics.board.value, { p50: board.p50, p95: board.p95 })}
              </Metric>
            )}
          </dl>
          {link.ordered && (
            <p className="diagnostics-card__note" data-tone="warning" role="status">
              {t(($) => $.diagnostics.ordered)}
            </p>
          )}
          {pauses > 0 && (
            <p
              className="diagnostics-card__note"
              data-tone={Object.keys(pausedNow).length ? 'warning' : undefined}
              role="status"
            >
              {t(($) => $.diagnostics.videoPaused, { count: pauses })}
            </p>
          )}
          <div className="diagnostics-card__actions">
            <Button size="sm" loading={network.running} onClick={() => void testNetwork()}>
              {network.running ? t(($) => $.diagnostics.checking) : t(($) => $.diagnostics.check)}
            </Button>
            {!!(network.times.length + network.failures) && (
              <p role="status" className="diagnostics-card__result">
                {t(($) => $.diagnostics.result.text, {
                  answer: network.times.length
                    ? t(($) => $.diagnostics.result.average, {
                        average: Math.round(network.times.reduce((a, b) => a + b, 0) / network.times.length),
                        min: Math.round(Math.min(...network.times)),
                        max: Math.round(Math.max(...network.times)),
                      })
                    : t(($) => $.diagnostics.result.none),
                  ok: network.times.length,
                  total: network.times.length + network.failures,
                })}
              </p>
            )}
          </div>
          <p className="diagnostics-card__note">{t(($) => $.diagnostics.footnote)}</p>
        </section>
        <section className="diagnostics-card" aria-labelledby={`${id}-details`}>
          <h3 className="diagnostics-card__title" id={`${id}-details`}>
            {t(($) => $.diagnostics.details)}
          </h3>
          {!samples.length && <p className="diagnostics-card__note">{t(($) => $.diagnostics.noTracks)}</p>}
          {samples.map((sample, i) => (
            <article className="diagnostics-track" key={`${sample.name}-${i}`}>
              <h4 className="diagnostics-track__title">
                {sample.name} ·{' '}
                {sample.kind === 'audio' ? t(($) => $.diagnostics.audio) : t(($) => $.diagnostics.video)} ·{' '}
                {sample.direction}
              </h4>
              <dl className="diagnostics-metrics">
                {sample.kind === 'video' && (
                  <>
                    <Metric label={t(($) => $.diagnostics.resolution)}>
                      {sample.width} × {sample.height}
                    </Metric>
                    <Metric label={t(($) => $.diagnostics.fps)}>{sample.fps.toFixed(1)}</Metric>
                  </>
                )}
                <Metric label={t(($) => $.diagnostics.bitrate)}>
                  {t(($) => $.diagnostics.kbps, { value: (sample.mbps * 1000).toFixed(0) })}
                </Metric>
                <Metric label={t(($) => $.diagnostics.loss)}>
                  {sample.loss === null ? t(($) => $.diagnostics.noData) : `${sample.loss.toFixed(1)}%`}
                </Metric>
                <Metric label={t(($) => $.diagnostics.connection)}>{sample.transport}</Metric>
                <Metric label={t(($) => $.diagnostics.rtt)}>
                  {sample.rttMs === null
                    ? t(($) => $.diagnostics.noData)
                    : t(($) => $.diagnostics.ms, { value: sample.rttMs.toFixed(0) })}
                </Metric>
                <Metric label={t(($) => $.diagnostics.codec)}>{sample.codec}</Metric>
                <Metric label={t(($) => $.diagnostics.bufferRx)}>
                  {sample.bufferMs === null
                    ? t(($) => $.diagnostics.noData)
                    : t(($) => $.diagnostics.ms, { value: sample.bufferMs.toFixed(0) })}
                </Metric>
                {/* Принятый звук (R09, R29): идёт ли что-то от издателя и сколько пропусков заполнил браузер. */}
                {sample.kind === 'audio' && !sample.outbound && (
                  <>
                    <Metric label={t(($) => $.diagnostics.source.label)}>
                      {sample.silentSource
                        ? t(($) => $.diagnostics.source.silent)
                        : t(($) => $.diagnostics.source.sound)}
                    </Metric>
                    <Metric label={t(($) => $.diagnostics.concealment)}>{sample.concealmentEvents}</Metric>
                  </>
                )}
                {sample.kind === 'video' && (
                  <>
                    <Metric
                      label={
                        sample.outbound ? t(($) => $.diagnostics.encode) : t(($) => $.diagnostics.decode)
                      }
                    >
                      {sample.processingMs === null
                        ? t(($) => $.diagnostics.noData)
                        : t(($) => $.diagnostics.ms, { value: sample.processingMs.toFixed(1) })}
                    </Metric>
                    <Metric label={t(($) => $.diagnostics.implementation)}>{sample.implementation}</Metric>
                    <Metric label={t(($) => $.diagnostics.limitation)}>
                      {isLimit(sample.limitation)
                        ? t(($) => $.diagnostics.limits[sample.limitation as Limit])
                        : sample.limitation}
                    </Metric>
                  </>
                )}
              </dl>
            </article>
          ))}
          <div className="diagnostics-card__actions">
            <Button size="sm" icon={<ClipboardCopy />} onClick={() => void copyReport()}>
              {t(($) => $.diagnostics.copyReport)}
            </Button>
            {copied && (
              <p role="status" className="diagnostics-card__result">
                {copied === 'done' ? t(($) => $.diagnostics.copied) : t(($) => $.diagnostics.copyFailed)}
              </p>
            )}
          </div>
        </section>
        <section className="diagnostics-card" aria-labelledby={`${id}-stuck`}>
          <h3 className="diagnostics-card__title" id={`${id}-stuck`}>
            {t(($) => $.diagnostics.stuck.title)}
          </h3>
          <p className="diagnostics-card__note">{t(($) => $.diagnostics.stuck.text)}</p>
          <div className="diagnostics-card__actions">
            <Button
              size="sm"
              icon={<RotateCcw />}
              disabled={media.status !== 'connected'}
              onClick={() => void meeting.media.returnToLive()}
            >
              {t(($) => $.diagnostics.stuck.button)}
            </Button>
          </div>
        </section>
      </div>
    </Dialog>
  );
}
