import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Headset } from 'lucide-react';
import { Dialog } from '../kit';
import { useStore } from '../primitives';
import { closeHelp, helpRequest } from './help';
import './help-button.css';

// Окно поддержки — отдельным чанком: частые вопросы и форма не нужны, пока «Поддержку» не нажали.
const HelpCenter = lazy(() => import('./HelpCenter').then((module) => ({ default: module.HelpCenter })));

/**
 * Единственное окно «Поддержка» (S5, R49) — на корне приложения, вне дерева того, кто его открыл:
 * диагностика, настройки или выдвижная панель закрываются, а поддержка остаётся и нажимается.
 * Слой — набора (`Dialog`, 50), как у всех окон; гарнитура перед заголовком — как принято (R37, R38).
 */
export function HelpHost() {
  const { t } = useTranslation();
  const request = useStore(helpRequest);
  const diagnostics = request?.onDiagnostics;
  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => {
        if (!open) closeHelp();
      }}
      title={t(($) => $.support.title)}
      icon={<Headset />}
      size="lg"
      className="help-dialog"
    >
      {request && (
        <Suspense fallback={<div className="help-loading" aria-busy="true" />}>
          <HelpCenter
            // Новая просьба при открытом окне (другой вопрос, «Сообщить о проблеме») — с её вкладки.
            key={`${request.faq ?? ''}:${request.report ? 'report' : ''}`}
            faq={request.faq}
            report={request.report}
            onDiagnostics={
              diagnostics
                ? () => {
                    closeHelp();
                    diagnostics();
                  }
                : undefined
            }
          />
        </Suspense>
      )}
    </Dialog>
  );
}
