import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Copy, Download as DownloadIcon, ShieldAlert, Server } from 'lucide-react';
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
        <a className="shell-header__home" href="/" aria-label="Cord — на главную">
          <Logo />
        </a>
        <div className="shell-header__end">
          <a className="ui-button ui-button--quiet ui-button--sm" href="/">
            <ArrowLeft size={16} aria-hidden="true" /> На главную
          </a>
        </div>
      </header>
      <main className="shell-main download-main">
        <section className="shell-card download-card">
          <AppIcon size={72} />
          <h1>Cord для Windows</h1>
          {release === undefined && <p className="download-card__meta">Смотрим, что опубликовано…</p>}
          {release === null && (
            <p className="download-card__meta" role="status">
              Сборка для Windows сейчас недоступна. Попробуйте открыть страницу чуть позже.
            </p>
          )}
          {release && (
            <>
              <p className="download-card__meta">
                {release.installer!.size > 0 && `${megabytes(release.installer!.size)}, `}Windows 10 build
                19041 и новее, x64
              </p>
              <a
                className="ui-button ui-button--primary ui-button--lg ui-button--full download-card__primary"
                href={release.installer!.url}
                download=""
              >
                <DownloadIcon size={18} aria-hidden="true" /> Скачать установщик
              </a>
              <p className="download-card__note">
                Установка для текущего пользователя — прав администратора не нужно. WebView2 поставится сам,
                если его ещё нет.
              </p>
              {release.portable && (
                <a className="download-card__portable" href={release.portable.url} download="">
                  Портативная сборка без установки, ZIP
                  {release.portable.size > 0 && `, ${megabytes(release.portable.size)}`}
                </a>
              )}
            </>
          )}
        </section>
        <section className="shell-card download-section">
          <h2>
            <Server size={18} aria-hidden="true" /> Куда подключаться после установки
          </h2>
          <p>
            Cord не подключается никуда сам — при первом запуске он спросит адрес сервера. Это адрес вот этой
            страницы, тот же, с которого вы сейчас скачиваете приложение:
          </p>
          <div className="download-address">
            <Server size={16} aria-hidden="true" />
            <input
              aria-label="Адрес этого сервера"
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
            {copied ? 'Адрес скопирован' : 'Скопировать адрес'}
          </Button>
          <p className="download-card__note">
            В Cord: «Указать первый сервер» → вставьте адрес → «Добавить». Имя и пароль — по желанию сервера;
            серверов можно держать несколько и переключаться между ними.
          </p>
        </section>
        <section className="shell-card download-section">
          <h2>
            <ShieldAlert size={18} aria-hidden="true" /> Windows покажет предупреждение
          </h2>
          <p>
            Установщик не подписан сертификатом издателя, поэтому SmartScreen скажет «Система Windows защитила
            ваш компьютер» и назовёт издателя неизвестным. Это говорится про любую новую программу без
            платного сертификата, а не про конкретно эту.
          </p>
          <ol>
            <li>
              В окне предупреждения нажмите <b>Подробнее</b>.
            </li>
            <li>
              Затем <b>Выполнить в любом случае</b>.
            </li>
          </ol>
          <p>
            Это один раз, при установке. Дальше Cord запускается обычно: пометку «скачано из интернета» несёт
            скачанный файл, а не то, что установщик положил на диск. У портативной сборки пометка остаётся на
            распакованных файлах, поэтому установщик спокойнее.
          </p>
        </section>
      </main>
    </div>
  );
}
