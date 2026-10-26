import type { StageKind } from '../core/stage-view';
import type { Translate } from '../i18n';

/** Имя интеграции на сцене — то же, что у её чипа и в панели «Интеграции». */
export function integrationName(t: Translate, kind: StageKind): string {
  if (kind === 'cinema') return t(($) => $.services.roster.cinema);
  if (kind === 'gartic') return 'Gartic';
  return t(($) => $.services.games[kind]);
}
