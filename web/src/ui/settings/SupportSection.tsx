import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Headset } from 'lucide-react';
import '../support/support.css';

// Вопросы, проверка и формы — отдельным чанком, как и окно поддержки: не нужны, пока раздел не открыт.
const HelpCenter = lazy(() =>
  import('../support/HelpCenter').then((module) => ({ default: module.HelpCenter })),
);

/**
 * Раздел «Поддержка» настроек (R51): над «О программе», с гарнитурой, как принято. Та же «Поддержка»,
 * что в окне на корне и на `/support`, — только прямо в правой части настроек: окно поддержки не
 * ложится вторым поверх настроек и не заменяет их.
 */
export function SupportSection() {
  const { t } = useTranslation();
  return (
    <div className="settings-support">
      <div className="settings-support__head">
        <span className="settings-support__icon" aria-hidden="true">
          <Headset />
        </span>
        <p className="help-lead">{t(($) => $.support.lead)}</p>
      </div>
      <Suspense fallback={<div className="help-loading" aria-busy="true" />}>
        <HelpCenter />
      </Suspense>
    </div>
  );
}
