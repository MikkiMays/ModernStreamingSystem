import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { locale } from '../i18n';
import { nodeProbe } from '../media/node-probe';
import { useToast } from './kit';
import { useStore } from './primitives';

/**
 * Два слова о узле встречи тостом (R200, Р-101/Р-104):
 *
 * - создатель просил узел руками, а ядро поставило встречу на другой (`Admission.nodeFallback`) —
 *   «Хельсинки занят — встреча создана во Франкфурте», один раз при входе;
 * - встреча переехала (`snapshot.mediaNode` сменился при росте `mediaMoves`: ведущий перевёл или узел
 *   умер) — «Встреча теперь на узле Хельсинки». Сам переезд делает `session.ts relocate`; здесь —
 *   только слова, чтобы пара секунд тишины не выглядела поломкой.
 */
export function NodeNotices({ meeting }: { meeting: Meeting }) {
  const { t } = useTranslation();
  const toast = useToast();
  const snapshot = useStore(meeting.snapshot);
  const seen = useRef<{ node: string | null | undefined; moves: number } | null>(null);
  useEffect(() => {
    const fallback = meeting.admission.nodeFallback;
    if (!fallback?.asked || !fallback.got) return;
    const language = locale(t);
    toast.add({
      title: t(($) => $.meeting.nodeFallback, {
        asked: nodeProbe.title(fallback.asked, language),
        got: nodeProbe.title(fallback.got, language),
      }),
      type: 'info',
      timeout: 8000,
    });
    // Один раз на вход: `admission` не меняется, тост по нему — тоже.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const now = { node: snapshot.mediaNode, moves: snapshot.mediaMoves ?? 0 };
    const before = seen.current;
    seen.current = now;
    if (!before || now.moves <= before.moves || !now.node || now.node === before.node) return;
    toast.add({
      title: t(($) => $.meeting.nodeMoved, { node: nodeProbe.title(now.node, locale(t)) }),
      type: 'info',
      timeout: 6000,
    });
    // `toast` и `t` стабильны; реагируем только на снимок.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.mediaNode, snapshot.mediaMoves]);
  return null;
}
