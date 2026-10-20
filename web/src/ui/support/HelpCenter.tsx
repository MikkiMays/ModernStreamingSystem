import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Activity, ChevronDown, Send } from 'lucide-react';
import { readPreferences } from '../../core/preferences';
import { AUTHOR_TELEGRAM, FAQ, type FaqId, type SupportTopic } from '../../core/support';
import { DeviceCheck } from '../DeviceCheck';
import { Button } from '../kit';
import { SupportForm } from './SupportForm';
import './support.css';

/** С какой темы начинать форму, если помощь открыли у конкретной беды. */
const TOPIC_OF: Record<FaqId, SupportTopic> = {
  camera: 'camera',
  microphone: 'camera',
  silent: 'sound',
  screen: 'screen',
  smartscreen: 'windows',
  network: 'network',
};

/**
 * «Помощь» целиком (E13, T36): частые вопросы, проверка устройств, форма обращения и Telegram
 * автора. Одно и то же на странице `/support` и в окне «?» — внутри встречи, где уйти на другую
 * страницу значило бы выйти из разговора.
 *
 * `faq` — вопрос, у которого человек застрял (нет доступа к камере — `camera`): он раскрыт первым,
 * и форма начинается с его темы. `onDiagnostics` — во встрече вместо проверки устройств открывается
 * её «Диагностика», где видно и связь.
 */
export function HelpCenter({ faq, onDiagnostics }: { faq?: FaqId; onDiagnostics?: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const preferences = useMemo(() => readPreferences(), []);
  const order = faq ? [faq, ...FAQ.filter((item) => item !== faq)] : [...FAQ];
  return (
    <div className="help-center">
      <section className="help-section help-faq" aria-labelledby={`${id}-faq`}>
        <h2 id={`${id}-faq`} className="help-section__title">
          {t(($) => $.support.faq.title)}
        </h2>
        <div className="help-faq__list">
          {order.map((item) => (
            <details key={item} className="help-faq__item" open={item === faq || undefined}>
              <summary>
                <span>{t(($) => $.support.faq.items[item].q)}</span>
                <ChevronDown size={18} aria-hidden="true" className="help-faq__chevron" />
              </summary>
              <ul className="help-faq__steps">
                {t(($) => $.support.faq.items[item].a)
                  .split('\n')
                  .map((line) => (
                    <li key={line}>{line}</li>
                  ))}
              </ul>
            </details>
          ))}
        </div>
      </section>
      <div className="help-side">
        <section className="help-section help-check" aria-labelledby={`${id}-check`}>
          <h2 id={`${id}-check`} className="help-section__title">
            {t(($) => $.support.check.title)}
          </h2>
          {onDiagnostics ? (
            <>
              <p className="help-section__lead">{t(($) => $.support.check.diagnosticsText)}</p>
              <Button size="sm" icon={<Activity size={16} />} onClick={onDiagnostics}>
                {t(($) => $.support.check.diagnostics)}
              </Button>
            </>
          ) : (
            <DeviceCheck preferences={preferences} />
          )}
        </section>
        <section className="help-section">
          <SupportForm topic={faq ? TOPIC_OF[faq] : undefined} />
        </section>
        <p className="help-author">
          <span>{t(($) => $.support.author.text)}</span>
          <a href={AUTHOR_TELEGRAM} target="_blank" rel="noopener noreferrer" className="help-author__link">
            <Send size={15} aria-hidden="true" />
            {t(($) => $.support.author.link)}
          </a>
        </p>
      </div>
    </div>
  );
}
