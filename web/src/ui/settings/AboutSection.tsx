import { useEffect, useState } from 'react';
import { Download, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import { isNewer, windowsRelease, type WindowsRelease } from '../../core/download';
import { desktopUpdate, desktopVersion, notifyDesktop } from '../../core/desktop';
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
  const desktop = !!window.chrome?.webview;
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
      ? 'Смотрим, какой выпуск последний…'
      : latest === null
        ? 'Не удалось узнать последний выпуск для Windows'
        : fresh
          ? 'Веб-клиент обновляется вместе с сервером'
          : `Последний выпуск для Windows — ${latest}`;
  return (
    <>
      <SettingGroup title="Cord" collapsible={false}>
        <SettingRow id="about-version" hint={desktop ? 'Приложение для Windows' : 'Веб-клиент этого сервера'}>
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
                    ? shell.status || 'Доступно обновление приложения.'
                    : `Для Windows вышел Cord ${latest}.`}
                </span>
              </p>
            ) : undefined
          }
        >
          <div className="setting-actions">
            <Button size="sm" icon={<RefreshCw />} loading={checking} onClick={check}>
              Проверить
            </Button>
            {desktop && shell.available && (
              <Button
                size="sm"
                variant="primary"
                icon={<Download />}
                onClick={() => notifyDesktop('update.apply')}
              >
                Обновить
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
                <span className="ui-button__label">Скачать {latest}</span>
              </a>
            )}
          </div>
        </SettingRow>
        <SettingRow id="about-author" hint={<>Cord создаёт и развивает @nikgers</>}>
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
            aria-label="Telegram автора"
            title="Telegram автора"
          >
            <Send size={18} />
          </a>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
