// Дашборды Grafana для профиля `monitoring` — как код (E10-B, docs/observability.md §7).
//
// Пишет infra/monitoring/grafana/dashboards/*.json из коротких описаний ниже. JSON коммитится рядом:
// контейнеру Grafana Node не нужен. Поправил описание — запусти и закоммить оба:
//
//   node infra/monitoring/grafana/dashboards.mjs
//
// Метрики Cord — `cord_*` из ядра (только перечислимые метки), LiveKit — `livekit_*`, машина —
// node_exporter, шлюз — `caddy_*`. Боты в SFU считаются участниками; людей показывает ядро.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), 'dashboards');
const source = { type: 'prometheus', uid: 'victoriametrics' };

const stat = (title, expr, unit = 'short') => ({
  type: 'stat',
  title,
  w: 4,
  h: 4,
  targets: [{ expr, legendFormat: title }],
  unit,
});

const series = (title, targets, unit = 'short', options = {}) => ({
  type: 'timeseries',
  title,
  w: options.w ?? 12,
  h: 8,
  targets: targets.map(([expr, legendFormat]) => ({ expr, legendFormat })),
  unit,
  stack: options.stack ?? false,
});

/** Доля времени отдачи источника с условием (`hw="hw"`, `codec=~"av1|h265"`) за час. */
const publishShare = (source, match) =>
  `sum(rate(cord_client_publish_seconds_total{source="${source}",${match}}[1h])) / sum(rate(cord_client_publish_seconds_total{source="${source}"}[1h]))`;
/** Доля каждого кодека во времени отдачи источника. */
const codecShare = (source) =>
  `sum by (codec) (rate(cord_client_publish_seconds_total{source="${source}"}[10m])) / ignoring(codec) group_left sum(rate(cord_client_publish_seconds_total{source="${source}"}[10m]))`;

function dashboard(uid, title, description, panels) {
  let x = 0;
  let y = 0;
  let row = 0;
  const laid = panels.map((panel, id) => {
    if (x + panel.w > 24) {
      x = 0;
      y += row;
      row = 0;
    }
    const gridPos = { x, y, w: panel.w, h: panel.h };
    x += panel.w;
    row = Math.max(row, panel.h);
    return {
      id: id + 1,
      type: panel.type,
      title: panel.title,
      datasource: source,
      gridPos,
      targets: panel.targets.map((t, i) => ({ ...t, refId: String.fromCharCode(65 + i), datasource: source })),
      fieldConfig: {
        defaults: {
          unit: panel.unit,
          ...(panel.type === 'timeseries'
            ? { custom: { fillOpacity: panel.stack ? 60 : 10, lineWidth: 2, stacking: { mode: panel.stack ? 'normal' : 'none' } } }
            : {}),
        },
        overrides: [],
      },
      options:
        panel.type === 'stat'
          ? { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'none', graphMode: 'area' }
          : { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi' } },
    };
  });
  return {
    uid,
    title,
    description,
    tags: ['cord'],
    timezone: 'browser',
    schemaVersion: 39,
    version: 1,
    editable: false,
    refresh: '1m',
    time: { from: 'now-24h', to: 'now' },
    panels: laid,
  };
}

// Оценка MOS по упрощённой E-модели (ITU-T G.107) из куратора — не наука, а чтобы «стало хуже» было
// графиком (docs/observability.md §4). Задержка «рот → ухо» d = оборот/2 + джиттер + 60 мс (кодек и
// буфер); Id = 0,024·d + 0,11·(d − 177,3)⁺; потери Ppl в процентах, Ie-eff = 95·Ppl/(Ppl + 10) (Opus
// с RED: Bpl ≈ 10); R = 93,2 − Id − Ie-eff; MOS = 1 + 0,035·R + 7·10⁻⁶·R·(R − 60)·(100 − R), в границах
// 1…4,5. Хорошая связь даёт ≈ 4,3; выше 4 — не слышно, ниже 3,6 — люди жалуются.
const d = '(max(cord_probe_rtt_ms) / 2 + max(cord_probe_jitter_ms{leg="down"}) + 60)';
const id = `(0.024 * ${d} + 0.11 * clamp_min(${d} - 177.3, 0))`;
const ppl = '(max(cord_probe_loss_ratio{leg="down"}) * 100)';
const ie = `(95 * ${ppl} / (${ppl} + 10))`;
const r = `(93.2 - ${id} - ${ie})`;
const mos = `clamp(1 + 0.035 * ${r} + 0.000007 * ${r} * (${r} - 60) * (100 - ${r}), 1, 4.5)`;

const dashboards = [
  dashboard('cord-meetings', 'Cord — встречи', 'Встречи, люди, входы и отказы — из ядра. Боты не люди.', [
    stat('Идут встречи', 'sum(cord_rooms_active{state="live"})'),
    stat('Ждут второго', 'sum(cord_rooms_active{state="waiting"})'),
    stat('Люди на местах', 'sum(cord_participants_active)'),
    stat('Люди на связи', 'sum(cord_participants_connected)'),
    stat('Боты', 'sum(cord_bots_active)'),
    stat('Демонстрации', 'sum(cord_screens_active)'),
    series('Встречи', [
      ['sum(cord_rooms_active{state="live"})', 'идут'],
      ['sum(cord_rooms_active{state="waiting"})', 'ждут второго'],
    ]),
    series('Люди', [
      ['sum(cord_participants_active)', 'на местах'],
      ['sum(cord_participants_connected)', 'на связи'],
      ['sum(cord_bots_active)', 'боты'],
    ]),
    series('Начато и завершено за час', [
      ['sum(increase(cord_meetings_started_total[1h]))', 'начато'],
      ['sum by (reason) (increase(cord_meetings_ended_total[1h]))', 'завершено: {{reason}}'],
    ]),
    series('Длительность встречи, медиана и p90', [
      ['histogram_quantile(0.5, sum by (le) (rate(cord_meeting_duration_seconds_bucket[6h])))', 'медиана'],
      ['histogram_quantile(0.9, sum by (le) (rate(cord_meeting_duration_seconds_bucket[6h])))', 'p90'],
    ], 's'),
    series('Входы по исходу, в минуту', [['sum by (result) (rate(cord_joins_total[5m])) * 60', '{{result}}']], 'short', { stack: true }),
    series('Интеграции идут сейчас', [['sum by (kind) (cord_integrations_active)', '{{kind}}']], 'short', { stack: true }),
    // Доска (R159): своя нагрузка мимо транзакций комнаты — доски в памяти, сокеты, правки и записи сцены.
    series('Доска: открыто и смотрят', [
      ['sum(cord_board_open)', 'досок в памяти'],
      ['sum(cord_board_peers)', 'сокетов'],
    ]),
    series('Доска: правки элементов, в секунду', [
      ['sum by (result) (rate(cord_board_elements_total[5m]))', '{{result}}'],
      ['sum(increase(cord_board_save_failures_total[1h]))', 'сцена не записалась за час'],
    ]),
    series('Отказы ядра по коду, в минуту (10 частых)', [['topk(10, sum by (code) (rate(cord_errors_total[5m])) * 60)', '{{code}}']], 'short', { w: 24 }),
    series('Блокировки', [['sum by (by, kind) (increase(cord_blocks_created_total[1h]))', '{{by}} · {{kind}}']]),
    series('Версия ядра', [['max by (version) (cord_build_info)', '{{version}}']]),
  ]),
  dashboard('cord-sfu', 'Cord — SFU', 'LiveKit целиком, по узлу: комнаты, подключения (боты считаются), пакеты, потери.', [
    stat('Комнаты в SFU', 'sum(livekit_room_total)'),
    stat('Подключения', 'sum(livekit_participant_total)'),
    stat('Входящий поток', 'sum(rate(livekit_packet_bytes{direction="incoming"}[5m])) * 8', 'bps'),
    stat('Исходящий поток', 'sum(rate(livekit_packet_bytes{direction="outgoing"}[5m])) * 8', 'bps'),
    series('Комнаты и подключения', [
      ['sum(livekit_room_total)', 'комнаты'],
      ['sum(livekit_participant_total)', 'подключения'],
    ]),
    series('Битрейт по направлению', [['sum by (direction) (rate(livekit_packet_bytes[5m])) * 8', '{{direction}}']], 'bps'),
    series('Потери пакетов, в секунду', [['sum(rate(livekit_packet_loss_total[5m]))', 'потеряно']]),
    series('NACK и PLI, в секунду', [
      ['sum(rate(livekit_nack_total[5m]))', 'NACK'],
      ['sum(rate(livekit_pli_total[5m]))', 'PLI'],
    ]),
    series('Переподключения клиентов (ядро)', [['sum(increase(cord_joins_total{door="rejoin"}[1h]))', 'возвраты за час']]),
  ]),
  dashboard('cord-media', 'Cord — медиа', 'Куратор через SFU, что слышат люди (сводки приёма), сторож музыки, площадки, кодеки отдачи (R152). W1b, docs/observability.md §4–5, docs/codecs.md.', [
    stat('Куратор: потери вниз', 'max(cord_probe_loss_ratio{leg="down"})', 'percentunit'),
    stat('Куратор: оборот', 'max(cord_probe_rtt_ms)', 'ms'),
    stat('Куратор: джиттер', 'max(cord_probe_jitter_ms{leg="down"})', 'ms'),
    stat('Оценка MOS (куратор)', mos, 'short'),
    stat('Обслуживание', 'max(cord_maintenance)'),
    stat('Музыка играет', 'sum(cord_music_sessions_active)'),
    series('Куратор: потери через SFU', [
      ['max(cord_probe_loss_ratio{leg="down"})', 'SFU → слушатель'],
      ['max(cord_probe_loss_ratio{leg="up"})', 'издатель → SFU'],
    ], 'percentunit'),
    series('Куратор: оборот и джиттер', [
      ['max(cord_probe_rtt_ms)', 'оборот'],
      ['max(cord_probe_jitter_ms{leg="down"})', 'джиттер вниз'],
      ['max(cord_probe_jitter_ms{leg="up"})', 'джиттер вверх'],
    ], 'ms'),
    series('Оценка MOS по упрощённой E-модели (куратор)', [[mos, 'MOS']], 'short'),
    series('Слышимые провалы в минуту (сводки приёма)', [['sum by (kind) (rate(cord_rx_concealment_events_total[5m])) * 60', '{{kind}}']]),
    series('Доля заглушки за 10 с, p90 по классу', [['histogram_quantile(0.9, sum by (kind, le) (rate(cord_rx_conceal_ratio_bucket[10m])))', '{{kind}}']], 'percentunit'),
    series('Запас буфера приёма, медиана по классу', [['histogram_quantile(0.5, sum by (kind, le) (rate(cord_rx_target_ms_bucket[10m])))', '{{kind}}']], 'ms'),
    series('Музыка: голодание, перезапуски, переподключения за час', [
      ['sum(increase(cord_music_underrun_total[1h]))', 'голодание'],
      ['sum(increase(cord_music_decoder_restarts_total[1h]))', 'перезапуски декодера'],
      ['sum(increase(cord_music_reconnects_total[1h]))', 'переподключения к SFU'],
      ['sum(increase(cord_music_tracks_skipped_total[1h]))', 'пропущено треков'],
    ]),
    series('Музыка: секунды тишины вместо музыки за час', [['sum(increase(cord_music_starved_seconds_total[1h]))', 'тишина']], 's'),
    series('Площадки отвечают с этого сервера', [
      ['min by (provider) (cord_cinema_reachable)', 'кино: {{provider}}'],
      ['min by (provider) (cord_music_reachable)', 'музыка: {{provider}}'],
    ]),
    series('Площадки: отказы «заняты» и повторы за сегментом за час', [
      ['sum(increase(cord_platform_busy_refusals_total[1h]))', 'отказы «заняты»'],
      ['sum(increase(cord_cinema_upstream_retries_total[1h]))', 'повторы за сегментом'],
      ['max(cord_platform_lanes_busy)', 'полос занято сейчас'],
    ]),
    series('Хост: замирания (soft lockup) за сутки', [['max(cord_host_soft_lockups_day)', 'за сутки']]),
    // Кодеки отдачи (R152): работает ли гибкий кодек — из 10-секундных сводок браузеров (`RxQuality.java`).
    stat('Камера в железе, доля за час', publishShare('camera', 'hw="hw"'), 'percentunit'),
    stat('Показ в железе, доля за час', publishShare('screen', 'hw="hw"'), 'percentunit'),
    stat('Показ на AV1/H.265, доля за час', publishShare('screen', 'codec=~"av1|h265"'), 'percentunit'),
    stat('Смен кодека за час', 'sum(increase(cord_client_codec_switch_total[1h]))'),
    series('Кодек камеры, доля времени отдачи', [[codecShare('camera'), '{{codec}}']], 'percentunit', { stack: true }),
    series('Кодек показа, доля времени отдачи', [[codecShare('screen'), '{{codec}}']], 'percentunit', { stack: true }),
    series('В железе или процессором, доля по источнику', [
      [
        'sum by (source, hw) (rate(cord_client_publish_seconds_total[10m])) / ignoring(hw) group_left sum by (source) (rate(cord_client_publish_seconds_total[10m]))',
        '{{source}}: {{hw}}',
      ],
    ], 'percentunit'),
    series('Что ограничивает кодировщик отдачи, доля времени', [
      [
        'sum by (source, reason) (rate(cord_client_tx_limited_seconds_total[10m])) / ignoring(reason) group_left sum by (source) (rate(cord_client_publish_seconds_total[10m]))',
        '{{source}}: {{reason}}',
      ],
    ], 'percentunit'),
    series('Смены кодека за час по причине', [['sum by (reason) (increase(cord_client_codec_switch_total[1h]))', '{{reason}}']], 'short', { stack: true }),
    series('Смены кодека за час: откуда и куда', [
      ['sum by (source, from, to) (increase(cord_client_codec_switch_total[1h]))', '{{source}}: {{from}} → {{to}}'],
    ]),
  ]),
  dashboard('cord-server', 'Cord — сервер', 'Машина, база, Redis, шлюз и сам мониторинг. Steal — время, которое отнял гипервизор.', [
    stat('ЦП занят', '1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))', 'percentunit'),
    stat('Steal', 'avg(rate(node_cpu_seconds_total{mode="steal"}[5m]))', 'percentunit'),
    stat('Память свободна', 'node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes', 'percentunit'),
    stat('Диск свободен', 'node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}', 'percentunit'),
    stat('Нагрузка (1 мин)', 'node_load1'),
    // Та же ступень, что люди видят палочками рядом с пингом (R143): 1 — свободно, 4 — мест нет.
    stat('Загрузка для людей (1–4)', 'max(cord_server_load_level)'),
    stat('Запросов к шлюзу', 'sum(rate(caddy_http_requests_total[5m]))', 'reqps'),
    series('ЦП по видам', [['sum by (mode) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) / scalar(count(node_cpu_seconds_total{mode="idle"}))', '{{mode}}']], 'percentunit', { stack: true }),
    series('Память', [
      ['node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes', 'занята'],
      ['node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes', 'своп'],
    ], 'bytes'),
    series('Сеть', [
      ['sum(rate(node_network_receive_bytes_total{device!~"lo|docker.*|veth.*|br-.*"}[5m])) * 8', 'принято'],
      ['sum(rate(node_network_transmit_bytes_total{device!~"lo|docker.*|veth.*|br-.*"}[5m])) * 8', 'отдано'],
    ], 'bps'),
    series('Ответы шлюза по коду', [['sum by (code) (rate(caddy_http_requests_total[5m]))', '{{code}}']], 'reqps', { stack: true }),
    series('Задержка шлюза p95', [['histogram_quantile(0.95, sum by (le) (rate(caddy_http_request_duration_seconds_bucket[5m])))', 'p95']], 's'),
    series('Память ядра (JVM heap)', [['sum(jvm_memory_used_bytes{job="core",area="heap"})', 'heap']], 'bytes'),
    series('PostgreSQL: соединения', [['sum(pg_stat_database_numbackends{datname="streaming"})', 'соединения']]),
    series('Redis: память', [['redis_memory_used_bytes', 'занято']], 'bytes'),
    series('Цена мониторинга: память процессов', [['process_resident_memory_bytes{job=~"victoriametrics|vmalert|alertmanager|node|postgres|redis|gatus"}', '{{job}}']], 'bytes', { w: 24 }),
  ]),
  dashboard('cord-uptime', 'Cord — доступность', 'Отвечает ли каждая часть Cord и как видно снаружи (Gatus).', [
    series('Цели сбора отвечают', [['min by (job) (up)', '{{job}}']], 'short', { w: 24 }),
    series('Проверки Gatus', [['min by (name) (gatus_results_endpoint_success)', '{{name}}']]),
    series('Время ответа снаружи', [['max by (name) (gatus_results_duration_seconds)', '{{name}}']], 's'),
    series('Дней до конца сертификата', [['min by (name) (gatus_results_certificate_expiration_seconds) / 86400', '{{name}}']], 'd'),
  ]),
];

await mkdir(out, { recursive: true });
for (const d of dashboards) await writeFile(join(out, `${d.uid}.json`), JSON.stringify(d, null, 2) + '\n');
console.log(`Записано ${dashboards.length} дашборда в ${out}`);
