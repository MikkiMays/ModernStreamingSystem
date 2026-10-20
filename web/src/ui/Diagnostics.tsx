import { useEffect, useState } from 'react';
import { RotateCcw, Wifi } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { publicApi } from '../api/client';
import { StatsSampler, type Sample } from '../media/diagnostics';
import { gradeName, pathName } from '../media/link-quality';
import { Modal, useStore } from './primitives';
import { DeviceCheck } from './DeviceCheck';
import { HelpButton } from './support/HelpButton';

/** Причины, которыми браузер объясняет ограничение передачи; незнакомую показываем как есть. */
const LIMITS = ['none', 'cpu', 'bandwidth', 'unknown'] as const;
type Limit = (typeof LIMITS)[number];
const isLimit = (value: string): value is Limit => (LIMITS as readonly string[]).includes(value);

export default function Diagnostics({ meeting, onClose }: { meeting: Meeting; onClose: () => void }) {
  const { t } = useTranslation();
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
    <Modal
      wide
      open
      onOpenChange={onClose}
      title={t(($) => $.diagnostics.title)}
      description={t(($) => $.diagnostics.description)}
    >
      <div className="diagnostics-list">
        <DeviceCheck preferences={preferences} />
        <section className="network-check">
          <h3>
            <Wifi size={19} /> {t(($) => $.diagnostics.network)}
          </h3>
          <dl className="network-metrics">
            <div>
              <dt>{t(($) => $.diagnostics.media.label)}</dt>
              <dd>
                {media.status === 'connected'
                  ? t(($) => $.diagnostics.media.connected)
                  : media.status === 'recovering'
                    ? t(($) => $.diagnostics.media.recovering)
                    : t(($) => $.diagnostics.media.disconnected)}
              </dd>
            </div>
            <div>
              <dt>{t(($) => $.diagnostics.control.label)}</dt>
              <dd>
                {control === 'connected'
                  ? t(($) => $.diagnostics.control.connected)
                  : control === 'closed'
                    ? t(($) => $.diagnostics.control.closed)
                    : t(($) => $.diagnostics.control.connecting)}
              </dd>
            </div>
            <div>
              <dt>{t(($) => $.diagnostics.quality.label)}</dt>
              <dd>{t(($) => $.diagnostics.quality.values[media.quality])}</dd>
            </div>
            <div>
              <dt>{t(($) => $.diagnostics.path)}</dt>
              <dd>
                {pathName(t, link.path)} · {gradeName(t, link.grade)}
              </dd>
            </div>
            <div>
              <dt>{t(($) => $.diagnostics.jitter.label)}</dt>
              <dd>
                {link.jitterMs === null
                  ? t(($) => $.diagnostics.noData)
                  : t(($) => $.diagnostics.jitter.value, { ms: Math.round(link.jitterMs) })}
              </dd>
            </div>
            <div>
              <dt>{t(($) => $.diagnostics.buffer.label)}</dt>
              <dd>
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
              </dd>
            </div>
          </dl>
          {link.ordered && (
            <p className="form-footnote" role="status">
              {t(($) => $.diagnostics.ordered)}
            </p>
          )}
          <button className="button secondary" disabled={network.running} onClick={() => void testNetwork()}>
            {network.running ? t(($) => $.diagnostics.checking) : t(($) => $.diagnostics.check)}
          </button>
          {!!(network.times.length + network.failures) && (
            <p role="status" className="network-result">
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
          <p className="form-footnote">{t(($) => $.diagnostics.footnote)}</p>
        </section>
        <details className="technical-diagnostics" open={samples.length > 0}>
          <summary>{t(($) => $.diagnostics.details)}</summary>
          {!samples.length && <p className="muted">{t(($) => $.diagnostics.noTracks)}</p>}
          {samples.map((sample, i) => (
            <article className="diagnostic-sample" key={`${sample.name}-${i}`}>
              <strong>
                {sample.name} ·{' '}
                {sample.kind === 'audio' ? t(($) => $.diagnostics.audio) : t(($) => $.diagnostics.video)} ·{' '}
                {sample.direction}
              </strong>
              <dl>
                {sample.kind === 'video' && (
                  <>
                    <div>
                      <dt>{t(($) => $.diagnostics.resolution)}</dt>
                      <dd>
                        {sample.width} × {sample.height}
                      </dd>
                    </div>
                    <div>
                      <dt>{t(($) => $.diagnostics.fps)}</dt>
                      <dd>{sample.fps.toFixed(1)}</dd>
                    </div>
                  </>
                )}
                <div>
                  <dt>{t(($) => $.diagnostics.bitrate)}</dt>
                  <dd>{t(($) => $.diagnostics.kbps, { value: (sample.mbps * 1000).toFixed(0) })}</dd>
                </div>
                <div>
                  <dt>{t(($) => $.diagnostics.loss)}</dt>
                  <dd>
                    {sample.loss === null ? t(($) => $.diagnostics.noData) : `${sample.loss.toFixed(1)}%`}
                  </dd>
                </div>
                <div>
                  <dt>{t(($) => $.diagnostics.connection)}</dt>
                  <dd>{sample.transport}</dd>
                </div>
                <div>
                  <dt>{t(($) => $.diagnostics.rtt)}</dt>
                  <dd>
                    {sample.rttMs === null
                      ? t(($) => $.diagnostics.noData)
                      : t(($) => $.diagnostics.ms, { value: sample.rttMs.toFixed(0) })}
                  </dd>
                </div>
                <div>
                  <dt>{t(($) => $.diagnostics.codec)}</dt>
                  <dd>{sample.codec}</dd>
                </div>
                <div>
                  <dt>{t(($) => $.diagnostics.bufferRx)}</dt>
                  <dd>
                    {sample.bufferMs === null
                      ? t(($) => $.diagnostics.noData)
                      : t(($) => $.diagnostics.ms, { value: sample.bufferMs.toFixed(0) })}
                  </dd>
                </div>
                {sample.kind === 'video' && (
                  <>
                    <div>
                      <dt>
                        {sample.outbound ? t(($) => $.diagnostics.encode) : t(($) => $.diagnostics.decode)}
                      </dt>
                      <dd>
                        {sample.processingMs === null
                          ? t(($) => $.diagnostics.noData)
                          : t(($) => $.diagnostics.ms, { value: sample.processingMs.toFixed(1) })}
                      </dd>
                    </div>
                    <div>
                      <dt>{t(($) => $.diagnostics.implementation)}</dt>
                      <dd>{sample.implementation}</dd>
                    </div>
                    <div>
                      <dt>{t(($) => $.diagnostics.limitation)}</dt>
                      <dd>
                        {isLimit(sample.limitation)
                          ? t(($) => $.diagnostics.limits[sample.limitation as Limit])
                          : sample.limitation}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            </article>
          ))}
        </details>
        <section className="network-check">
          <h3>{t(($) => $.diagnostics.stuck.title)}</h3>
          <p className="form-footnote">{t(($) => $.diagnostics.stuck.text)}</p>
          <button
            className="button secondary"
            disabled={media.status !== 'connected'}
            onClick={() => void meeting.media.returnToLive()}
          >
            <RotateCcw size={17} />
            {t(($) => $.diagnostics.stuck.button)}
          </button>
        </section>
        <p className="diagnostics-help">
          <span>{t(($) => $.diagnostics.help)}</span>
          <HelpButton faq="network" look="text" />
        </p>
      </div>
    </Modal>
  );
}
