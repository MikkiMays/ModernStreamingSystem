import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Translate } from '../../i18n';
import { locale } from '../../i18n';
import { formatCode } from '../../core/invitation';
import { activityApi, type Quality } from '../../core/activity';
import { Button } from '../kit';
import { Bars } from './Bars';
import { Failure, Tile, useAdmin, when } from './Activity';

const PERIODS = { day: 1, week: 7, month: 30 } as const;
type Period = keyof typeof PERIODS;
const NONE = '—';

/** Число по языку страницы: до одного знака после запятой. */
function number(t: Translate, value: number, digits = 1) {
  return new Intl.NumberFormat(locale(t), { maximumFractionDigits: digits }).format(value);
}

const ms = (t: Translate, value: number | null) =>
  value === null ? NONE : t(($) => $.activity.quality.ms, { value: number(t, value, 0) });
const percent = (t: Translate, value: number | null) =>
  value === null ? NONE : t(($) => $.activity.quality.percent, { value: number(t, value) });
const share = (t: Translate, value: number | null) => percent(t, value === null ? null : value * 100);

/**
 * «Качество» на странице владельца (docs/observability.md §12, §15): что видели браузеры участников —
 * итоги звонков (client-report), которые ядро складывает в строку встречи. Только числа: ни имён, ни
 * адресов в итогах нет. Встреча, где был один человек, встречей не считается и итогов не копит.
 */
export function QualityTab({ onExpired }: { onExpired: () => void }) {
  const { t } = useTranslation();
  const { run, error } = useAdmin(onExpired);
  const [period, setPeriod] = useState<Period>('week');
  const [quality, setQuality] = useState<Quality | null>(null);
  useEffect(() => {
    const to = Date.now();
    const from = to - PERIODS[period] * 86_400_000;
    void run(() => activityApi.quality(from, to)).then((value) => value && setQuality(value));
  }, [period, run]);
  const days = useMemo(() => {
    if (!quality) return [];
    const format = new Intl.DateTimeFormat(locale(t), { day: 'numeric', month: 'short' });
    return quality.days.map((day) => ({
      key: day.day,
      label: format.format(new Date(`${day.day}T12:00:00`)),
      value: day.rttMs ?? 0,
      tip: t(($) => $.activity.quality.dayTip, {
        rtt: ms(t, day.rttMs),
        loss: percent(t, day.lossPercent),
        count: day.reports,
      }),
    }));
  }, [quality, t]);
  return (
    <section className="activity-section">
      <div className="activity-filters" role="group" aria-label={t(($) => $.activity.meetings.period)}>
        {(Object.keys(PERIODS) as Period[]).map((key) => (
          <Button
            key={key}
            size="sm"
            variant={period === key ? 'primary' : 'secondary'}
            aria-pressed={period === key}
            onClick={() => setPeriod(key)}
          >
            {t(($) => $.activity.meetings.periods[key])}
          </Button>
        ))}
      </div>
      <p className="activity-hint">{t(($) => $.activity.quality.hint)}</p>
      <Failure text={error} />
      {quality &&
        (quality.reports === 0 ? (
          <p className="activity-empty">{t(($) => $.activity.quality.empty)}</p>
        ) : (
          <>
            <div className="activity-tiles">
              <Tile label={t(($) => $.activity.quality.meetings)} value={quality.meetings} />
              <Tile label={t(($) => $.activity.quality.calls)} value={quality.reports} />
              <Tile label={t(($) => $.activity.quality.rtt)} value={ms(t, quality.rttMs)} />
              <Tile label={t(($) => $.activity.quality.rttMax)} value={ms(t, quality.rttMaxMs)} />
              <Tile label={t(($) => $.activity.quality.loss)} value={percent(t, quality.lossPercent)} />
              <Tile label={t(($) => $.activity.quality.lossy)} value={share(t, quality.lossyShare)} />
              <Tile label={t(($) => $.activity.quality.jitter)} value={ms(t, quality.jitterMs)} />
              <Tile
                label={t(($) => $.activity.quality.bitrate)}
                value={
                  quality.bitrateKbps === null
                    ? NONE
                    : t(($) => $.activity.quality.mbps, { value: number(t, quality.bitrateKbps / 1000) })
                }
              />
              <Tile
                label={t(($) => $.activity.quality.freezes)}
                value={quality.freezesPerHour === null ? NONE : number(t, quality.freezesPerHour)}
              />
              <Tile label={t(($) => $.activity.quality.relay)} value={share(t, quality.relayShare)} />
            </div>
            <div className="activity-charts">
              <Bars title={t(($) => $.activity.quality.byDay)} items={days} />
              <Bars
                title={t(($) => $.activity.quality.codecs)}
                horizontal
                items={Object.entries(quality.codecs).map(([codec, count]) => ({
                  key: codec,
                  label: codec.toUpperCase(),
                  value: count,
                  tip: t(($) => $.activity.quality.codecTip, { count }),
                }))}
              />
            </div>
            <h2 className="activity-subtitle">{t(($) => $.activity.quality.recent)}</h2>
            <div className="activity-table-wrap">
              <table className="activity-table">
                <thead>
                  <tr>
                    <th scope="col">{t(($) => $.activity.quality.columns.code)}</th>
                    <th scope="col">{t(($) => $.activity.quality.columns.started)}</th>
                    <th scope="col">{t(($) => $.activity.quality.columns.calls)}</th>
                    <th scope="col">{t(($) => $.activity.quality.columns.rtt)}</th>
                    <th scope="col">{t(($) => $.activity.quality.columns.loss)}</th>
                    <th scope="col">{t(($) => $.activity.quality.columns.jitter)}</th>
                    <th scope="col">{t(($) => $.activity.quality.columns.freezes)}</th>
                    <th scope="col">{t(($) => $.activity.quality.columns.relay)}</th>
                  </tr>
                </thead>
                <tbody>
                  {quality.recent.map((meeting) => (
                    <tr key={`${meeting.code ?? ''}:${meeting.startedAt}`}>
                      <td className="activity-mono">
                        {meeting.code ? formatCode(meeting.code) : t(($) => $.activity.quality.gone)}
                      </td>
                      <td>{when(t, meeting.startedAt)}</td>
                      <td>{meeting.reports}</td>
                      <td>
                        {ms(t, meeting.rttMs)}
                        {meeting.rttMaxMs !== null &&
                          meeting.rttMaxMs !== meeting.rttMs &&
                          ` · ${t(($) => $.activity.quality.worst, { value: ms(t, meeting.rttMaxMs) })}`}
                      </td>
                      <td>{percent(t, meeting.lossPercent)}</td>
                      <td>{ms(t, meeting.jitterMs)}</td>
                      <td>{meeting.freezes}</td>
                      <td>
                        {meeting.relay ? t(($) => $.activity.quality.yes) : t(($) => $.activity.quality.no)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ))}
    </section>
  );
}
