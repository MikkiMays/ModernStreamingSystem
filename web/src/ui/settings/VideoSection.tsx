import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Track } from 'livekit-client';
import type { Meeting } from '../../core/meeting';
import { Store } from '../../core/store';
import type { MediaTile } from '../../media/session';
import { useMediaQuery, useStore } from '../primitives';
import type { Preferences } from '../../core/preferences';
import { Switch } from '../kit';
import { SettingGroup, SettingRow } from './Row';
import { rowText } from './sections';
import { CameraPreview } from './CameraPreview';
import { DeviceSelect, useMediaDevices } from './devices';
import { QualityRows } from './media-fields';

type Change = (patch: Partial<Preferences>) => Promise<void>;
const noTiles = new Store<MediaTile[]>([]);

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
  // Камера встречи, если она включена: превью показывает её, а не захватывает камеру второй раз.
  const tiles = useStore(meeting?.media.tracks ?? noTiles);
  const camera = tiles.find((tile) => tile.local && tile.source === Track.Source.Camera && !tile.muted);
  const live = camera?.track.mediaStreamTrack;
  /*
    Превью — тоже включение камеры: на телефоне оно открывается фронтальной (Р-35), как встреча и
    предвход, а не запомненной после «перевернуть». Выбрали камеру в списке — превью показывает её.
    Список держит ту камеру, что в превью, пока выбора руками не было.
  */
  const coarse = useMediaQuery('(pointer: coarse)');
  const [picked, setPicked] = useState(false);
  const [shown, setShown] = useState<string>();
  return (
    <>
      <SettingGroup title={t(($) => $.settings.anchors.camera)} anchor="camera">
        <div className="setting-camera">
          <CameraPreview
            deviceId={preferences.devices.camera}
            front={coarse && !picked}
            profile={preferences.camera}
            live={live?.readyState === 'live' ? live : null}
            onDevice={setShown}
          />
          <div className="setting-camera__rows">
            <SettingRow id="camera-device" stack>
              <DeviceSelect
                kind="videoinput"
                label={rowText(t, 'camera-device').label}
                devices={devices}
                preferences={preferences}
                change={change}
                meeting={meeting}
                shown={picked ? undefined : shown}
                onPick={() => setPicked(true)}
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

      <SettingGroup
        title={t(($) => $.settings.anchors.screen)}
        anchor="screen"
        // Что значит выбранное (X10): нижняя граница, а не цель — одной строкой на всю группу.
        note={t(($) => $.settings.media.floorNote)}
      >
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
