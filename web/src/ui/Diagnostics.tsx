import { useEffect, useId, useState, type ReactNode } from 'react';
import { CircleHelp, RotateCcw, Wifi } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { publicApi } from '../api/client';
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
 * «Диагностика» встречи: проверка своих устройств, сеть, подробности каждой дорожки и «зависло».
 *
 * Окно набора (`Dialog`, слой 50), без подзаголовка (R47). Подробности аудио и видео — обычный
 * раздел, а не сворачиваемый `<details>` с системным ▼ (R48): прятать нечего, это и есть ответ на
 * «почему лагает». Разделы — карточками на токенах отступов (R29). «Помощь» внизу закрывает
 * диагностику и открывает помощь (`onHelp`, R49): окна заменяют друг друга, а не ложатся стопкой.
 */
export default function Diagnostics({
  meeting,
  onClose,
  onHelp,
}: {
  meeting: Meeting;
  onClose: () => void;
  onHelp: () => void;
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
  const preferences = useStore(meeting.media.preferences);
  const media = useStore(meeting.media.state);
  const link = useStore(meeting.media.link);
  const control = useStore(meeting.control.state);
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
          <span className="diagnostics-dialog__help">{t(($) => $.diagnostics.help)}</span>
          <Button size="sm" variant="quiet" icon={<CircleHelp />} onClick={onHelp}>
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
          </dl>
          {link.ordered && (
            <p className="diagnostics-card__note" data-tone="warning" role="status">
              {t(($) => $.diagnostics.ordered)}
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
