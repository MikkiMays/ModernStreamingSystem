import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { Logo } from '../primitives';
import { HelpCenter } from './HelpCenter';
import { FAQ, type FaqId } from '../../core/support';
import '../shell.css';

/**
 * Страница `/support` (E13, T36) — как `/download`, вне приложения: без сессии сервера и без
 * встречи. Её можно дать ссылкой тому, кто ещё не вошёл, и открыть, когда Cord не подключается.
 * Вопрос можно назвать в адресе: `/support#camera` раскроет его первым.
 */
export function SupportPage() {
  const { t } = useTranslation();
  const anchor = typeof location === 'undefined' ? '' : location.hash.slice(1);
  const faq = (FAQ as readonly string[]).includes(anchor) ? (anchor as FaqId) : undefined;
  return (
    <div className="shell-page help-page">
      <header className="shell-header">
        <a className="shell-header__home" href="/" aria-label={t(($) => $.support.home)}>
          <Logo />
        </a>
        <div className="shell-header__end">
          <a className="ui-button ui-button--quiet ui-button--sm" href="/">
            <ArrowLeft size={16} aria-hidden="true" /> {t(($) => $.support.back)}
          </a>
        </div>
      </header>
      <main className="shell-main help-main">
        <header className="help-hero">
          <h1>{t(($) => $.support.title)}</h1>
          <p>{t(($) => $.support.lead)}</p>
        </header>
        <HelpCenter faq={faq} />
      </main>
    </div>
  );
}
