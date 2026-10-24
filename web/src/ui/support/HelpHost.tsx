import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../kit';
import { useStore } from '../primitives';
import { closeHelp, helpRequest } from './help';
import './help-button.css';

// Окно помощи — отдельным чанком: частые вопросы и форма не нужны, пока «Помощь» не нажали.
const HelpCenter = lazy(() => import('./HelpCenter').then((module) => ({ default: module.HelpCenter })));

/**
 * Единственное окно «Помощь» (S5, R49) — на корне приложения, вне дерева того, кто его открыл:
 * диагностика, настройки или выдвижная панель закрываются, а помощь остаётся и нажимается.
 * Слой — набора (`Dialog`, 50), как у всех окон.
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
      size="lg"
      className="help-dialog"
    >
      {request && (
        <Suspense fallback={<div className="help-loading" aria-busy="true" />}>
          <HelpCenter
            faq={request.faq}
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
