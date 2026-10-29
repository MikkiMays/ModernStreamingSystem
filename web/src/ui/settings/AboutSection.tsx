import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Compass, Download, RefreshCw, TriangleAlert } from 'lucide-react';
import { windowsRelease, type WindowsRelease } from '../../core/download';
import { desktopUpdate, desktopVersion, notifyDesktop, isDesktop } from '../../core/desktop';
import { appVersion } from '../../core/version';
import { useStore } from '../primitives';
import { Button } from '../kit';
import { SettingGroup, SettingRow } from './Row';

/**
 * «О программе»: что здесь установлено и не вышло ли нового. Номер версии в Cord показывается
 * только здесь (T58); ссылок на исходники и «обновите сервер» нет (T56, П15), строки «Автор» —
 * тоже (R50): Cord — продукт, а не чей-то проект. Поддержка — свой раздел над этим, с гарнитурой
 * (R51), а не строка «Открыть» со вторым окном.
 *
 * Два разных вопроса. В браузере обновлять нечего — страница и есть то, что сервер отдал сию
 * секунду, — поэтому там нет ни «Обновлений», ни «Проверить» (R132): версия говорит «всегда
 * последняя», а строка «Приложение для Windows» называет последний выпуск и предлагает его скачать.
 * В самом приложении обновлять есть что, и проверку выполняет оболочка: страница о её файлах ничего
 * не знает. Плашка появляется, только когда есть что сказать: «всё актуально» видно по её отсутствию.
 *
 * В приложении раздел зеркало сам не спрашивает — только по «Проверить»: оболочка уже спросила его
 * при запуске (и спрашивает раз в шесть часов), а её ответ раздел берёт из `update.version`. В
 * браузере при открытии читается, какой клиент для Windows последний на этом сервере.
 */
export function AboutSection({ onTour }: { onTour?: () => void }) {
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
  useEffect(() => {
    if (!desktop) check();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const latest = release === undefined ? undefined : (release?.version ?? null);
  // Плашка ниже говорит о новом выпуске; подпись строки — о том, что известно сейчас.
  const updates = shell.available ? undefined : shell.status || undefined;
  /** Что известно о приложении для Windows — в браузере, строкой под «Приложение для Windows». */
  const app =
    latest === undefined
      ? t(($) => $.settings.about.checking)
      : latest === null
        ? t(($) => $.settings.about.unknown)
        : t(($) => $.settings.about.latest, { version: latest });
  return (
    <>
      <SettingGroup title="Cord">
        <SettingRow
          id="about-version"
          hint={desktop ? t(($) => $.settings.about.desktop) : t(($) => $.settings.about.webUpdates)}
        >
          <span className="setting-value setting-value--strong">
            Cord {desktop ? desktopVersion(shell) || '…' : appVersion}
          </span>
        </SettingRow>
        {desktop ? (
          <SettingRow
            id="about-updates"
            hint={updates ? <span role="status">{updates}</span> : null}
            below={
              shell.available ? (
                <p className="setting-note" data-tone="warning" role="status">
                  <TriangleAlert size={16} aria-hidden="true" />
                  <span>{shell.status || t(($) => $.settings.about.desktopUpdate)}</span>
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
              {shell.available && (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Download />}
                  onClick={() => notifyDesktop('update.apply')}
                >
                  {t(($) => $.settings.about.update)}
                </Button>
              )}
            </div>
          </SettingRow>
        ) : (
          <SettingRow id="about-app" hint={<span role="status">{app}</span>}>
            {/* Установщик — прямой ссылкой, когда зеркало его назвало; иначе — страница «Скачать». */}
            <a
              className="ui-button ui-button--secondary ui-button--sm"
              href={release?.installer?.url ?? '/download'}
              download={release?.installer ? '' : undefined}
            >
              <span className="ui-button__icon" aria-hidden="true">
                <Download />
              </span>
              <span className="ui-button__label">
                {latest
                  ? t(($) => $.settings.about.download, { version: latest })
                  : t(($) => $.settings.about.get)}
              </span>
            </a>
          </SettingRow>
        )}
        {onTour && (
          <SettingRow id="about-tour">
            <Button size="sm" icon={<Compass />} onClick={onTour}>
              {t(($) => $.settings.about.tour)}
            </Button>
          </SettingRow>
        )}
      </SettingGroup>
    </>
  );
}
