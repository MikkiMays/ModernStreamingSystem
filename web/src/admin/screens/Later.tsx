import { Construction, ExternalLink } from 'lucide-react';
import { text } from '../../i18n/admin/ru';
import type { Section } from '../AdminApp';
import { DASHBOARDS, dashboardUrl, NEW_TAB } from '../grafana';
import { Empty, Panel } from '../parts';

/**
 * Раздел, который в проекте есть, а в коде ещё нет: честно говорим, что и когда (§11). «Метрики и журналы»
 * уже сейчас ведут в Grafana пульта (R220): все дашборды — ссылками в новую вкладку.
 */
export function Later({ section }: { section: Section }) {
  const hint = (text.later as Record<string, string>)[section] ?? '';
  return (
    <div className="admin-stack">
      {section === 'metrics' && <GrafanaPanel />}
      <Panel title={text.later.title}>
        <Empty icon={<Construction />}>
          {hint}{' '}
          <span className="admin-sub">
            {text.later.hint} <code>§11</code>.
          </span>
        </Empty>
      </Panel>
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
