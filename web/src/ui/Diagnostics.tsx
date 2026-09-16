import { useEffect, useState } from 'react';
import { RotateCcw, Wifi } from 'lucide-react';
import type { Meeting } from '../core/meeting';
import { publicApi } from '../api/client';
import { StatsSampler, type Sample } from '../media/diagnostics';
import { gradeName, pathName } from '../media/link-quality';
import { Modal, useStore } from './primitives';
import { DeviceCheck } from './DeviceCheck';

export default function Diagnostics({ meeting, onClose }: { meeting: Meeting; onClose: () => void }) {
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
      title="Диагностика"
      description="Проверьте устройства и фактическое соединение этой встречи."
    >
      <div className="diagnostics-list">
        <DeviceCheck preferences={preferences} />
        <section className="network-check">
          <h3>
            <Wifi size={19} /> Сеть
          </h3>
          <dl className="network-metrics">
            <div>
              <dt>Аудио и видео</dt>
              <dd>
                {media.status === 'connected'
                  ? 'Подключены'
                  : media.status === 'recovering'
                    ? 'Восстанавливаются'
                    : 'Не подключены'}
              </dd>
            </div>
            <div>
              <dt>Чат и управление</dt>
              <dd>
                {control === 'connected' ? 'Подключены' : control === 'closed' ? 'Отключены' : 'Подключение…'}
              </dd>
            </div>
            <div>
              <dt>Качество по данным сервера медиа</dt>
              <dd>
                {
                  {
                    excellent: 'Отличное',
                    good: 'Хорошее',
                    poor: 'Слабое',
                    lost: 'Связь потеряна',
                    unknown: 'Пока нет данных',
                  }[media.quality]
                }
              </dd>
            </div>
            <div>
              <dt>Путь медиа</dt>
              <dd>
                {pathName(link.path)} · {gradeName(link.grade)}
              </dd>
            </div>
            <div>
              <dt>Неровность прихода пакетов</dt>
              <dd>{link.jitterMs === null ? 'Нет данных' : `${Math.round(link.jitterMs)} мс, пик`}</dd>
            </div>
            <div>
              <dt>Запас буфера, который просит клиент</dt>
              <dd>
                {targets.length
                  ? targets
                      .map(
                        (target) =>
                          `${{ conversation: 'разговор', media: 'музыка и экран', video: 'видео' }[target.kind]} ${target.targetMs} мс`,
                      )
                      .join(' · ')
                  : 'Нет подписанных дорожек'}
              </dd>
            </div>
          </dl>
          {link.ordered && (
            <p className="form-footnote" role="status">
              Медиа идёт через ретранслятор поверх TCP/TLS. Такой путь не теряет пакеты, а переспрашивает их,
              и всё пришедшее следом ждёт опоздавшего — на слух это «замолчало, а потом заговорило быстрее».
              Запас буфера поднят автоматически. Если это повторяется, проверьте, пропускает ли сеть UDP до
              сервера медиа: прямой путь заметно ровнее.
            </p>
          )}
          <button className="button secondary" disabled={network.running} onClick={() => void testNetwork()}>
            {network.running ? 'Проверяем…' : 'Проверить сеть'}
          </button>
          {!!(network.times.length + network.failures) && (
            <p role="status" className="network-result">
              Ответ сервера:{' '}
              {network.times.length
                ? `${Math.round(network.times.reduce((a, b) => a + b, 0) / network.times.length)} мс в среднем · ${Math.round(Math.min(...network.times))}–${Math.round(Math.max(...network.times))} мс`
                : 'не получен'}
              . Успешных запросов: {network.times.length} из {network.times.length + network.failures}.
            </p>
          )}
          <p className="form-footnote">
            Проверка измеряет время ответа сервера приложения. Маршрут аудио и видео, потери пакетов и RTT до
            медиасервера показаны ниже, когда во встрече передаются дорожки.
          </p>
        </section>
        <details className="technical-diagnostics" open={samples.length > 0}>
          <summary>Подробности аудио и видео</summary>
          {!samples.length && (
            <p className="muted">
              Во встрече пока нет активных дорожек. Локальная проверка устройств не отправляет тест на
              медиасервер.
            </p>
          )}
          {samples.map((sample, i) => (
            <article className="diagnostic-sample" key={`${sample.name}-${i}`}>
              <strong>
                {sample.name} · {sample.kind === 'audio' ? 'Аудио' : 'Видео'} · {sample.direction}
              </strong>
              <dl>
                {sample.kind === 'video' && (
                  <>
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
                  </>
                )}
                <div>
                  <dt>Битрейт</dt>
                  <dd>{(sample.mbps * 1000).toFixed(0)} Кбит/с</dd>
                </div>
                <div>
                  <dt>Потери пакетов за интервал</dt>
                  <dd>{sample.loss === null ? 'Нет данных' : `${sample.loss.toFixed(1)}%`}</dd>
                </div>
                <div>
                  <dt>Соединение</dt>
                  <dd>{sample.transport}</dd>
                </div>
                <div>
                  <dt>RTT до медиасервера</dt>
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
                {sample.kind === 'video' && (
                  <>
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
                        {{
                          none: 'Не обнаружено',
                          cpu: 'Кодировщик / CPU',
                          bandwidth: 'Канал связи',
                          unknown: 'Нет данных от отправителя',
                        }[sample.limitation] ?? sample.limitation}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            </article>
          ))}
        </details>
        <section className="network-check">
          <h3>Изображение или звук зависли?</h3>
          <p className="form-footnote">
            Обновим получение дорожек от других участников. Возможна короткая пауза.
          </p>
          <button
            className="button secondary"
            disabled={media.status !== 'connected'}
            onClick={() => void meeting.media.returnToLive()}
          >
            <RotateCcw size={17} />
            Обновить аудио и видео
          </button>
        </section>
      </div>
    </Modal>
  );
}
