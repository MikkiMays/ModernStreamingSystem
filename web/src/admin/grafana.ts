/**
 * Grafana пульта (R212, R220): шлюз пульта отдаёт её на том же имени под `/grafana/`, вход — тем же клиентским
 * сертификатом, Grafana сама входит владельцем (прокси-заголовок, `infra/Caddyfile`). Пульт её не встраивает, а
 * открывает отдельной вкладкой — графикам нужен весь экран, а пульту — свой.
 *
 * Идентификаторы — из `infra/monitoring/grafana/dashboards.mjs` (тест сверяет с собранными JSON): главный —
 * «Cord — флот», он же домашний дашборд Grafana.
 */
export const GRAFANA_BASE = '/grafana/';

export const DASHBOARDS = [
  'cord-fleet',
  'cord-meetings',
  'cord-sfu',
  'cord-media',
  'cord-server',
  'cord-uptime',
] as const;

export type DashboardId = (typeof DASHBOARDS)[number];

export const MAIN_DASHBOARD: DashboardId = 'cord-fleet';

export function dashboardUrl(uid: DashboardId = MAIN_DASHBOARD): string {
  return `${GRAFANA_BASE}d/${uid}`;
}

/** Атрибуты ссылки «в новой вкладке»: без `opener` и без `Referer` — Grafana не узнает адрес раздела пульта. */
export const NEW_TAB = { target: '_blank', rel: 'noopener noreferrer' } as const;
