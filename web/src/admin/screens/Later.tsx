import { ExternalLink } from 'lucide-react';
import { text } from '../../i18n/admin/ru';
import { DASHBOARDS, dashboardUrl, NEW_TAB } from '../grafana';
import { Panel } from '../parts';

/** «Метрики и журналы» (R220): долгие ряды и журналы — в Grafana пульта; все дашборды — ссылками в новую вкладку. */
export function Metrics() {
  return (
    <div className="admin-stack">
      <GrafanaPanel />
    </div>
  );
}

export function GrafanaPanel() {
  return (
    <Panel title={text.grafana.title} description={text.grafana.hint}>
      <ul className="admin-links">
        {DASHBOARDS.map((uid) => (
          <li key={uid}>
            <a href={dashboardUrl(uid)} {...NEW_TAB}>
              {text.grafana.dashboards[uid] ?? uid}
              <ExternalLink aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
