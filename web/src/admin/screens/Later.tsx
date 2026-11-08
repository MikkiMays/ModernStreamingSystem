import { text } from '../../i18n/admin/ru';
import type { Section } from '../AdminApp';
import { Panel } from '../parts';

/** Раздел, который в проекте есть, а в коде ещё нет: честно говорим, что и когда (§11). */
export function Later({ section }: { section: Section }) {
  const hint = (text.later as Record<string, string>)[section] ?? '';
  return (
    <Panel title={text.later.title}>
      <p className="admin-hint">{hint}</p>
      <p className="admin-hint">
        {text.later.hint} <code>§11</code>.
      </p>
    </Panel>
  );
}
