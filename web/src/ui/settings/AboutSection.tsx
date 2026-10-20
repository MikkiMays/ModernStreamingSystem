import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import { isNewer, windowsRelease, type WindowsRelease } from '../../core/download';
import { desktopUpdate, desktopVersion, notifyDesktop, isDesktop } from '../../core/desktop';
import { appLabel, appVersion } from '../../core/version';
import { useStore } from '../primitives';
import { Button } from '../kit';
import { SettingGroup, SettingRow } from './Row';

/**
 * «О программе»: что здесь установлено и не вышло ли нового. Номер версии в Cord показывается
 * только здесь (T58); ссылок на исходники и «обновите сервер» нет (T56, П15).
 *
 * Два разных вопроса. В браузере обновлять нечего — страница и есть то, что сервер отдал сию
 * секунду, — поэтому проверка отвечает про клиент для Windows. В самом приложении обновлять
 * есть что, и проверку выполняет оболочка: страница о её файлах ничего не знает. Плашка
 * появляется, только когда есть что сказать: «всё актуально» видно по её отсутствию.
 */
export function AboutSection() {
  const { t } = useTranslation();
  const desktop = isDesktop();
  const shell = useStore(desktopUpdate);
  const [release, setRelease] = useState<WindowsRelease | null | undefined>(undefined);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (desktop) notifyDesktop('update.version');
  }, [desktop]);
  const check = () => {
    setChecking(true);
    if (desktop) {
      notifyDesktop('update.check');
      // Ответ придёт сообщением от оболочки; кнопка не должна остаться нажатой навсегда, если
      // оболочка старая и о такой команде не знает.
      setTimeout(() => setChecking(false), 4000);
      return;
    }
    setRelease(undefined);
    void windowsRelease()
      .then(setRelease)
      .finally(() => setChecking(false));
  };
  useEffect(check, []); // eslint-disable-line react-hooks/exhaustive-deps
  const latest = release === undefined ? undefined : (release?.version ?? null);
  const installed = desktop ? desktopVersion(shell) : appVersion;
  const fresh = !!latest && !!installed && isNewer(latest, installed);
  // Плашка ниже говорит о новом выпуске; подпись строки — о том, что известно сейчас.
  const updates = desktop
    ? shell.available
      ? undefined
      : shell.status || undefined
    : latest === undefined
      ? t(($) => $.settings.about.checking)
      : latest === null
        ? t(($) => $.settings.about.unknown)
        : fresh
          ? t(($) => $.settings.about.webUpdates)
          : t(($) => $.settings.about.latest, { version: latest });
  return (
    <>
      <SettingGroup title="Cord" collapsible={false}>
        <SettingRow
          id="about-version"
          hint={desktop ? t(($) => $.settings.about.desktop) : t(($) => $.settings.about.web)}
        >
          <span className="setting-value setting-value--strong">
            Cord {desktop ? desktopVersion(shell) || '…' : appLabel}
          </span>
        </SettingRow>
        <SettingRow
          id="about-updates"
          hint={updates ? <span role="status">{updates}</span> : null}
          below={
            (desktop && shell.available) || (!desktop && fresh) ? (
              <p className="setting-note" data-tone="warning" role="status">
                <TriangleAlert size={15} aria-hidden="true" />
                <span>
                  {desktop
                    ? shell.status || t(($) => $.settings.about.desktopUpdate)
                    : t(($) => $.settings.about.windowsUpdate, { version: latest })}
                </span>
              </p>
            ) : undefined
          }
        >
          <div className="setting-actions">
            <Button
              size="sm"
              icon={<RefreshCw />}
              loading={checking}
              aria-label={t(($) => $.settings.about.checkLabel)}
              onClick={check}
            >
              {t(($) => $.settings.about.check)}
            </Button>
            {desktop && shell.available && (
              <Button
                size="sm"
                variant="primary"
                icon={<Download />}
                onClick={() => notifyDesktop('update.apply')}
              >
                {t(($) => $.settings.about.update)}
              </Button>
            )}
            {!desktop && fresh && release?.installer && (
              <a
                className="ui-button ui-button--primary ui-button--sm"
                href={release.installer.url}
                download=""
              >
                <span className="ui-button__icon" aria-hidden="true">
                  <Download />
                </span>
                <span className="ui-button__label">
                  {t(($) => $.settings.about.download, { version: latest })}
                </span>
              </a>
            )}
          </div>
        </SettingRow>
        <SettingRow id="about-author" hint={t(($) => $.settings.about.author)}>
          {/*
            У ссылки один значок: конверт Telegram узнаётся и без подписи, а подпись рядом с именем
            автора читалась как призыв написать. Имя для доступности — в `aria-label`.
            Внешняя ссылка — с `target="_blank"`: оболочка Windows отдаёт системному браузеру
            только то, что просит новое окно, а переход внутри окна отменяет.
          */}
          <a
            className="ui-icon-button ui-icon-button--ghost ui-icon-button--md"
            href="https://t.me/nikgers"
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t(($) => $.settings.about.telegram)}
            title={t(($) => $.settings.about.telegram)}
          >
            <Send size={18} />
          </a>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
