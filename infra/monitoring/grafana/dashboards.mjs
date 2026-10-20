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
  dashboard('cord-server', 'Cord — сервер', 'Машина, база, Redis, шлюз и сам мониторинг. Steal — время, которое отнял гипервизор.', [
    stat('ЦП занят', '1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))', 'percentunit'),
    stat('Steal', 'avg(rate(node_cpu_seconds_total{mode="steal"}[5m]))', 'percentunit'),
    stat('Память свободна', 'node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes', 'percentunit'),
    stat('Диск свободен', 'node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}', 'percentunit'),
    stat('Нагрузка (1 мин)', 'node_load1'),
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
