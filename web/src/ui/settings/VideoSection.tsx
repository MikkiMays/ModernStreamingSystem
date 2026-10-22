import { useTranslation } from 'react-i18next';
import type { Meeting } from '../../core/meeting';
import type { Preferences } from '../../core/preferences';
import { Switch } from '../kit';
import { SettingGroup, SettingRow } from './Row';
import { rowText } from './sections';
import { CameraPreview } from './CameraPreview';
import { DeviceSelect, useMediaDevices } from './devices';
import { QualityRows } from './media-fields';

type Change = (patch: Partial<Preferences>) => Promise<void>;

/**
 * «Видео» (R100): сверху — превью камеры, как у Телемоста (n09), рядом — выбор камеры и её
 * качество; ниже — качество показа экрана по умолчанию и превью показа для зрителей (R80). Шкала
 * качества одна на камеру и показ (R78). Режим «чёткость / плавность» и звук показа выбирают в окне
 * показа — это решение на каждый показ, а не настройка навсегда.
 */
export function VideoSection({
  preferences,
  change,
  meeting,
}: {
  preferences: Preferences;
  change: Change;
  meeting?: Meeting;
}) {
  const { t } = useTranslation();
  const devices = useMediaDevices();
  return (
    <>
      <SettingGroup title={t(($) => $.settings.anchors.camera)} anchor="camera">
        <div className="setting-camera">
          <CameraPreview deviceId={preferences.devices.camera} />
          <div className="setting-camera__rows">
            <SettingRow id="camera-device" stack>
              <DeviceSelect
                kind="videoinput"
                label={rowText(t, 'camera-device').label}
                devices={devices}
                preferences={preferences}
                change={change}
                meeting={meeting}
              />
            </SettingRow>
            <QualityRows
              kind="camera"
              value={preferences.camera}
              onChange={(camera) => {
                if (meeting) void meeting.media.setCameraProfile(camera);
                else void change({ camera });
              }}
            />
          </div>
        </div>
      </SettingGroup>

      <SettingGroup title={t(($) => $.settings.anchors.screen)} anchor="screen">
        <QualityRows
          kind="screen"
          value={preferences.screen}
          onChange={(screen) => {
            if (meeting) void meeting.media.setProfile(screen);
            else void change({ screen });
          }}
        />
        <SettingRow id="screen-preview">
          <Switch
            checked={preferences.screen.preview !== false}
            ariaLabel={rowText(t, 'screen-preview').label}
            // Умолчание для следующего показа; идущий показ решает своё в окне показа.
            onCheckedChange={(preview) => void change({ screen: { ...preferences.screen, preview } })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
