import type { Preferences } from '../../core/preferences';
import type { Theme } from '../primitives';
import { Switch } from '../kit';
import { SettingGroup, SettingRow } from './Row';
import { row, rowDomId } from './sections';

const THEMES: { value: Theme; title: string }[] = [
  { value: 'system', title: 'Как в системе' },
  { value: 'light', title: 'Светлая' },
  { value: 'dark', title: 'Тёмная' },
];

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
  return (
    <>
      {theme && setTheme && (
        <SettingGroup title="Тема" collapsible={false}>
          <div className="setting-row setting-row--wide" id={rowDomId('appearance-theme')}>
            <div role="radiogroup" aria-label={row('appearance-theme').label} className="theme-picker">
              {THEMES.map((option) => (
                <label
                  key={option.value}
                  className="theme-option"
                  data-checked={theme === option.value || undefined}
                >
                  <input
                    type="radio"
                    name="cord-theme"
                    className="theme-option__input"
                    value={option.value}
                    checked={theme === option.value}
                    onChange={() => setTheme(option.value)}
                  />
                  <span className="theme-option__preview">
                    {option.value === 'system' ? (
                      <>
                        <Sample theme="light" />
                        <Sample theme="dark" />
                      </>
                    ) : (
                      <Sample theme={option.value} />
                    )}
                  </span>
                  <span className="theme-option__label">{option.title}</span>
                </label>
              ))}
            </div>
          </div>
        </SettingGroup>
      )}
      <SettingGroup title="Во встрече" collapsible={false}>
        <SettingRow id="appearance-bots">
          <Switch
            checked={preferences.showIntegrationPanel}
            ariaLabel={row('appearance-bots').label}
            onCheckedChange={(showIntegrationPanel) => void change({ showIntegrationPanel })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
