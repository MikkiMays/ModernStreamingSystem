import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageUp, Trash2 } from 'lucide-react';
import type { Preferences } from '../../core/preferences';
import { openPicture } from '../../core/avatar';
import { AvatarCropper } from '../AvatarCropper';
import { Avatar } from '../primitives';
import { Button } from '../kit';
import { SettingGroup, SettingRow } from './Row';

type Change = (patch: Partial<Preferences>) => Promise<void>;

/**
 * Картинка профиля: выбрать, обрезать, заменить или убрать.
 *
 * ЗДЕСЬ ЖЕ И ОТКАЗ. Комната картинку **проверяет**, и отказ — такая же часть этого разговора,
 * как согласие. Раньше он проглатывался (`catch(() => {})`), и выглядело это хуже любой
 * ошибки: в настройках новая картинка стоит, у комнаты — старая или никакой. Теперь отказ
 * виден, а местная картинка возвращается к прежней: два места не должны расходиться молча.
 *
 * Выбор доступен и на телефоне: неудобно было кадрирование, а не выбор, и кадрирование давно
 * работает пальцем; телефон же — ровно то место, где лежат все фотографии человека.
 */
function AvatarRow({ preferences, change }: { preferences: Preferences; change: Change }) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Выбранная картинка до того, как выбран кадр: пока она здесь, открыто окно кадрирования.
  const [chosen, setChosen] = useState<ImageBitmap | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const forget = () => {
    chosen?.close();
    setChosen(null);
  };
  /** Поставить картинку и сказать правду о том, чем это кончилось. */
  const apply = async (avatar: string) => {
    const previous = preferences.avatar;
    setError('');
    setBusy(true);
    try {
      await change({ avatar });
    } catch (problem) {
      await change({ avatar: previous }).catch(() => {});
      setError((problem as Error).message || t(($) => $.settings.profile.refused));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow
      id="profile-avatar"
      below={
        <>
          {error && (
            <p className="setting-note" data-tone="danger" role="alert">
              {error}
            </p>
          )}
          {chosen && (
            <AvatarCropper
              bitmap={chosen}
              onCancel={forget}
              onSave={(avatar) => {
                void apply(avatar);
                forget();
              }}
            />
          )}
        </>
      }
    >
      <div className="setting-avatar">
        <Avatar name={preferences.name || t(($) => $.settings.you)} src={preferences.avatar || null} />
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          aria-label={t(($) => $.settings.profile.pickLabel)}
          onChange={async (e) => {
            const picked = e.target.files?.[0];
            e.target.value = '';
            if (!picked) return;
            setBusy(true);
            setError('');
            try {
              // Кадр выбирается после чтения файла, а не вместо него: в кружок попадёт то, что
              // человек увидит в рамке, а не то, что оказалось в середине снимка.
              setChosen(await openPicture(picked));
            } catch (problem) {
              setError((problem as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
        <Button size="sm" icon={<ImageUp />} loading={busy} onClick={() => file.current?.click()}>
          {preferences.avatar ? t(($) => $.settings.profile.replace) : t(($) => $.settings.profile.pick)}
        </Button>
        {preferences.avatar && (
          <Button size="sm" variant="quiet" icon={<Trash2 />} disabled={busy} onClick={() => void apply('')}>
            {t(($) => $.settings.profile.remove)}
          </Button>
        )}
      </div>
    </SettingRow>
  );
}

/** «Профиль» устройства: учётных записей в Cord нет, имя и картинка живут здесь. */
export function ProfileSection({ preferences, change }: { preferences: Preferences; change: Change }) {
  const { t } = useTranslation();
  return (
    <SettingGroup title={t(($) => $.settings.profile.about)} collapsible={false}>
      <SettingRow id="profile-name" stack>
        {(a11y) => (
          <input
            className="ui-input setting-text"
            {...a11y}
            maxLength={40}
            value={preferences.name}
            autoComplete="nickname"
            placeholder={t(($) => $.settings.profile.namePlaceholder)}
            onChange={(e) => void change({ name: e.target.value })}
          />
        )}
      </SettingRow>
      <AvatarRow preferences={preferences} change={change} />
    </SettingGroup>
  );
}
