import { useEffect, useState } from 'react';
import { ArrowLeft, Download as DownloadIcon, ShieldAlert } from 'lucide-react';
import { AppIcon, Logo, ThemeButton, type Theme } from './primitives';
import {
  INSTALLER_URL,
  PORTABLE_URL,
  RELEASES_PAGE,
  megabytes,
  windowsRelease,
  type WindowsRelease,
} from '../core/download';

/**
 * The page behind «Скачать Cord». It is deliberately outside the application: no server
 * session, no meeting, nothing to connect to. Somebody who has just been given the address
 * should be able to get the client before they have a password or an invitation.
 */
export function Download({ theme, setTheme }: { theme: Theme; setTheme: (theme: Theme) => void }) {
  const [release, setRelease] = useState<WindowsRelease | null | undefined>(undefined);
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
    <div className="download-page">
      <header className="app-header">
        <a className="header-home" href="/">
          <Logo />
        </a>
        <div className="header-end">
          <a className="text-button" href="/">
            <ArrowLeft size={16} /> На главную
          </a>
          <ThemeButton theme={theme} setTheme={setTheme} />
        </div>
      </header>
      <main className="download-main">
        <section className="download-card">
          <AppIcon size={76} />
          <h1>Cord для Windows</h1>
          {release === undefined && <p className="muted">Смотрим, что опубликовано…</p>}
          {/*
            Даже когда ни этот сервер, ни GitHub не ответили, кнопка остаётся: постоянный адрес
            последнего релиза не требует ни того, ни другого. Исчезающая кнопка «скачать» —
            худший из возможных ответов на вопрос «где скачать».
          */}
          {release === null && (
            <>
              <p className="muted">Последняя сборка · Windows 10 build 19041 и новее, x64</p>
              <a className="button primary full download-primary" href={INSTALLER_URL}>
                <DownloadIcon size={19} /> Скачать установщик
              </a>
              <p className="form-footnote download-note">
                Установка для текущего пользователя — прав администратора не нужно. WebView2 поставится сам,
                если его ещё нет.
              </p>
              <a className="text-button download-portable" href={PORTABLE_URL}>
                Портативная сборка без установки · ZIP
              </a>
            </>
          )}
          {release && (
            <>
              <p className="muted">
                Версия {release.version}
                {release.installer!.size > 0 && ` · ${megabytes(release.installer!.size)}`} · Windows 10 build
                19041 и новее, x64
              </p>
              <a
                className="button primary full download-primary"
                href={release.installer!.url}
                download={release.origin === 'server' ? '' : undefined}
              >
                <DownloadIcon size={19} /> Скачать установщик
              </a>
              <p className="form-footnote download-note">
                Установка для текущего пользователя — прав администратора не нужно. WebView2 поставится сам,
                если его ещё нет.
              </p>
              {release.portable && (
                <a
                  className="text-button download-portable"
                  href={release.portable.url}
                  download={release.origin === 'server' ? '' : undefined}
                >
                  Портативная сборка без установки · ZIP
                  {release.portable.size > 0 && `, ${megabytes(release.portable.size)}`}
                </a>
              )}
              <a className="text-button download-portable" href={RELEASES_PAGE}>
                Все выпуски и что в них поменялось
              </a>
            </>
          )}
        </section>
        <section className="download-warning">
          <h2>
            <ShieldAlert size={19} /> Windows покажет предупреждение
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
          <p className="form-footnote download-note">
            Установщик собирает GitHub Actions из исходников этого проекта; контрольные суммы каждого выпуска
            лежат рядом с ним на странице релиза.
          </p>
        </section>
      </main>
    </div>
  );
}
