import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Copy, Download as DownloadIcon, ShieldAlert, Server } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { AppIcon, Logo } from './primitives';
import { Button } from './kit';
import { megabytes, windowsRelease, type WindowsRelease } from '../core/download';
import './shell.css';

/**
 * The page behind «Скачать Cord». It is deliberately outside the application: no server
 * session, no meeting, nothing to connect to. Somebody who has just been given the address
 * should be able to get the client before they have a password or an invitation.
 *
 * Кнопка ведёт на последний опубликованный установщик, а его номер не печатается (T58): версию
 * показывает только «О программе». Номер остаётся там, где его читает не человек, а браузер и
 * Windows, — в адресе файла и в его имени.
 */
export function Download() {
  const { t } = useTranslation();
  const [release, setRelease] = useState<WindowsRelease | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  /**
   * Адрес, который спросит Cord при первом запуске, — это адрес **вот этой** страницы.
   *
   * Приложение не знает никакого сервера заранее и ничего не угадывает; единственное место,
   * где этот адрес заведомо известен, — сервер, с которого человек сейчас качает установщик.
   * Поэтому он написан здесь, целиком и с кнопкой «скопировать».
   */
  const address = typeof location === 'undefined' ? '' : location.origin + '/';
  useEffect(() => {
    let active = true;
    void windowsRelease().then((found) => {
      if (active) setRelease(found);
    });
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="shell-page">
      <header className="shell-header">
        <a className="shell-header__home" href="/" aria-label={t(($) => $.download.home)}>
          <Logo />
        </a>
        <div className="shell-header__end">
          <a className="ui-button ui-button--quiet ui-button--sm" href="/">
            <ArrowLeft size={16} aria-hidden="true" /> {t(($) => $.download.back)}
          </a>
        </div>
      </header>
      <main className="shell-main download-main">
        <section className="shell-card download-card">
          <AppIcon size={72} />
          <h1>{t(($) => $.download.title)}</h1>
          {release === undefined && <p className="download-card__meta">{t(($) => $.download.checking)}</p>}
          {release === null && (
            <p className="download-card__meta" role="status">
              {t(($) => $.download.unavailable)}
            </p>
          )}
          {release && (
            <>
              <p className="download-card__meta">
                {release.installer!.size > 0 && `${megabytes(t, release.installer!.size)}, `}
                {t(($) => $.download.requirements)}
              </p>
              <a
                className="ui-button ui-button--primary ui-button--lg ui-button--full download-card__primary"
                href={release.installer!.url}
                download=""
              >
                <DownloadIcon size={18} aria-hidden="true" /> {t(($) => $.download.installer)}
              </a>
              <p className="download-card__note">{t(($) => $.download.installNote)}</p>
              {release.portable && (
                <a className="download-card__portable" href={release.portable.url} download="">
                  {t(($) => $.download.portable)}
                  {release.portable.size > 0 && `, ${megabytes(t, release.portable.size)}`}
                </a>
              )}
            </>
          )}
        </section>
        <section className="shell-card download-section">
          <h2>
            <Server size={18} aria-hidden="true" /> {t(($) => $.download.connect.title)}
          </h2>
          <p>{t(($) => $.download.connect.text)}</p>
          <div className="download-address">
            <Server size={16} aria-hidden="true" />
            <input
              aria-label={t(($) => $.download.connect.address)}
              value={address}
              readOnly
              onFocus={(e) => e.target.select()}
            />
          </div>
          <Button
            full
            icon={copied ? <Check size={16} /> : <Copy size={16} />}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(address);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? t(($) => $.download.connect.copied) : t(($) => $.download.connect.copy)}
          </Button>
          <p className="download-card__note">{t(($) => $.download.connect.note)}</p>
        </section>
        <section className="shell-card download-section">
          <h2>
            <ShieldAlert size={18} aria-hidden="true" /> {t(($) => $.download.warning.title)}
          </h2>
          <p>{t(($) => $.download.warning.text)}</p>
          <ol>
            <li>
              <Trans i18nKey={($) => $.download.warning.details} components={{ b: <b /> }} />
            </li>
            <li>
              <Trans i18nKey={($) => $.download.warning.run} components={{ b: <b /> }} />
            </li>
          </ol>
          <p>{t(($) => $.download.warning.after)}</p>
        </section>
      </main>
    </div>
  );
}
