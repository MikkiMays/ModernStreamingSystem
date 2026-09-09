import { useEffect, useState } from 'react';
import type { Meeting } from '../core/meeting';
import { StatsSampler, type Sample } from '../media/diagnostics';
import { Modal } from './primitives';

export default function Diagnostics({ meeting, onClose }: { meeting: Meeting; onClose: () => void }) {
  const [samples, setSamples] = useState<(Sample & { name: string })[]>([]);
  useEffect(() => {
    let disposed = false;
    let busy = false;
    const sampler = new StatsSampler();
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void Promise.all(
        meeting.media.tracks
          .get()
          .filter((t) => t.track.kind === 'video')
          .map(async (tile) =>
            (await sampler.sample(tile.track).catch(() => [])).map((s) => ({ ...s, name: tile.name })),
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
  const requested = meeting.media.requestedProfile;
  return (
    <Modal
      open
      onOpenChange={onClose}
      title="Качество соединения"
      description={`Запрошено для экрана: ${requested.resolution}p · ${requested.fps} кадров/с. Фактические значения обновляются раз в секунду.`}
    >
      <div className="diagnostics-list">
        {!samples.length && (
          <p className="muted">Включите камеру или демонстрацию, чтобы увидеть статистику.</p>
        )}
        {samples.map((sample, i) => (
          <article className="diagnostic-sample" key={`${sample.name}-${i}`}>
            <strong>
              {sample.name} · {sample.direction}
            </strong>
            <dl>
              <div>
                <dt>Разрешение</dt>
                <dd>
                  {sample.width} × {sample.height}
                </dd>
              </div>
              <div>
                <dt>Кадры в секунду</dt>
                <dd>{sample.fps.toFixed(1)}</dd>
              </div>
              <div>
                <dt>Битрейт</dt>
                <dd>{sample.mbps.toFixed(2)} Мбит/с</dd>
              </div>
              <div>
                <dt>Потери за интервал</dt>
                <dd>{sample.loss === null ? 'Нет данных' : `${sample.loss.toFixed(1)}%`}</dd>
              </div>
              <div>
                <dt>Соединение</dt>
                <dd>{sample.transport}</dd>
              </div>
              <div>
                <dt>RTT до SFU</dt>
                <dd>{sample.rttMs === null ? 'Нет данных' : `${sample.rttMs.toFixed(0)} мс`}</dd>
              </div>
              <div>
                <dt>Кодек</dt>
                <dd>{sample.codec}</dd>
              </div>
              <div>
                <dt>Буфер приёма</dt>
                <dd>{sample.bufferMs === null ? 'Нет данных' : `${sample.bufferMs.toFixed(0)} мс`}</dd>
              </div>
              <div>
                <dt>{sample.direction === 'Передача' ? 'Кодирование кадра' : 'Декодирование кадра'}</dt>
                <dd>
                  {sample.processingMs === null ? 'Нет данных' : `${sample.processingMs.toFixed(1)} мс`}
                </dd>
              </div>
              <div>
                <dt>Обработчик видео</dt>
                <dd>{sample.implementation}</dd>
              </div>
              <div>
                <dt>Ограничение</dt>
                <dd>
                  {sample.limitation === 'none'
                    ? 'Не обнаружено'
                    : sample.limitation === 'cpu'
                      ? 'Кодировщик / CPU'
                      : sample.limitation === 'bandwidth'
                        ? 'Канал связи'
                        : sample.limitation === 'unknown'
                          ? 'Нет данных от отправителя'
                          : sample.limitation}
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
      <p className="form-footnote">
        На статичном экране низкая частота кадров нормальна. Эти данные не измеряют задержку от захвата до
        изображения у зрителя. RTT — путь до SFU и обратно, а не задержка между двумя экранами.
      </p>
    </Modal>
  );
}
