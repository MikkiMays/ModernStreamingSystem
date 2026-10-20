import { useTranslation } from 'react-i18next';
import type { Preferences } from '../../core/preferences';
import { applyLanguage, isLanguage, LANGUAGE_NAMES, LANGUAGES } from '../../i18n';
import type { Theme } from '../primitives';
import { Switch } from '../kit';
import { SettingGroup, SettingRow } from './Row';
import { rowDomId, rowText } from './sections';

const THEMES: Theme[] = ['system', 'light', 'dark'];

/** Окошко-образец в цветах темы: `data-theme` действует и на вложенном элементе (E16). */
function Sample({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <span className="theme-sample" data-theme={theme} aria-hidden="true">
      <span className="theme-sample__rail" />
      <span className="theme-sample__body">
        <span className="theme-sample__line theme-sample__line--title" />
        <span className="theme-sample__line" />
        <span className="theme-sample__line theme-sample__line--short" />
        <span className="theme-sample__button" />
      </span>
    </span>
  );
}

/**
 * «Оформление» (T41): тема живёт только здесь — кнопки темы в шапках больше нет (E02). Три
 * образца вместо выпадающего списка: тему выбирают глазами, а не по слову. Выбор сохраняется на
 * устройстве и сразу применяется — и к окну приложения тоже.
 *
 * Там же язык (E14): тоже вид, а не поведение, и тоже свой у устройства. Список — самоназвания
 * языков: человеку, который случайно выбрал чужой, нужно узнать свой, не читая текущий.
 */
export function AppearanceSection({
  theme,
  setTheme,
  preferences,
  change,
}: {
  theme?: Theme;
  setTheme?: (theme: Theme) => void;
  preferences: Preferences;
  change: (patch: Partial<Preferences>) => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <>
      {theme && setTheme && (
        <SettingGroup title={t(($) => $.settings.appearance.theme)} collapsible={false}>
          <div className="setting-row setting-row--wide" id={rowDomId('appearance-theme')}>
            <div role="radiogroup" aria-label={rowText(t, 'appearance-theme').label} className="theme-picker">
              {THEMES.map((option) => (
                <label key={option} className="theme-option" data-checked={theme === option || undefined}>
                  <input
                    type="radio"
                    name="cord-theme"
                    className="theme-option__input"
                    value={option}
                    checked={theme === option}
                    onChange={() => setTheme(option)}
                  />
                  <span className="theme-option__preview">
                    {option === 'system' ? (
                      <>
                        <Sample theme="light" />
                        <Sample theme="dark" />
                      </>
                    ) : (
                      <Sample theme={option} />
                    )}
                  </span>
                  <span className="theme-option__label">
                    {t(($) => $.settings.appearance.themes[option])}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </SettingGroup>
      )}
      <SettingGroup title={t(($) => $.language.label)} collapsible={false}>
        <SettingRow id="appearance-language">
          {(a11y) => (
            <select
              {...a11y}
              className="ui-input ui-select setting-select"
              value={preferences.language ?? ''}
              onChange={(event) => {
                const language = isLanguage(event.target.value) ? event.target.value : null;
                void change({ language }).then(() => applyLanguage(language));
              }}
            >
              <option value="">{t(($) => $.language.system)}</option>
              {LANGUAGES.map((language) => (
                <option key={language} value={language} lang={language}>
                  {LANGUAGE_NAMES[language]}
                </option>
              ))}
            </select>
          )}
        </SettingRow>
      </SettingGroup>
      <SettingGroup title={t(($) => $.settings.appearance.inMeeting)} collapsible={false}>
        <SettingRow id="appearance-bots">
          <Switch
            checked={preferences.showIntegrationPanel}
            ariaLabel={rowText(t, 'appearance-bots').label}
            onCheckedChange={(showIntegrationPanel) => void change({ showIntegrationPanel })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
