import { useState } from 'react';
import { Music2, Unplug } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../../core/meeting';
import { musicSourceName, type MusicTrack } from '../../core/services';
import { Unreachable } from '../cinema/catalog/notes';
import { musicHint } from '../integration-shelf';
import { Button } from '../kit';
import { MusicPlayer } from '../MusicPlayer';
import { MusicQueue } from '../MusicQueue';
import { MusicSearch } from '../MusicSearch';
import { MusicUpload } from '../MusicUpload';
import { platformTiles, type MusicPlatform } from '../music-platforms';
import { PlatformTabs } from '../PlatformPicker';
import { useStore } from '../primitives';
import { YandexIntegration, useYandexAccount } from '../YandexIntegration';
import type { MusicControl } from './useMusic';

/**
 * Плеер музыки целиком (R44, DESIGN → «Плеер»): площадки вкладками и поиск — внутри плеера, ниже
 * «Сейчас играет», «Далее в очереди» и «Убрать музыку». Один и тот же в панели интеграций и в виджете
 * над звонком (R31): управлять музыкой можно, не переключаясь между интеграциями.
 *
 * ПОРЯДОК — ЭТО ПОВЕДЕНИЕ, А НЕ ОФОРМЛЕНИЕ. Пока музыки во встрече нет, плеер предлагает ровно одно
 * действие — добавить её: треки в очередь без бота складывались бы, но играть их было бы некому. Вход
 * не начинается с экрана площадок: площадка — выбор устройства, вкладка помнит его, и смена площадки
 * меняет только то, где ищут, — плеер, очередь и бот остаются как были.
 */
export function MusicWidget({ meeting, music }: { meeting: Meeting; music: MusicControl }) {
  return (
    <div className="music-widget">
      <MusicBody meeting={meeting} music={music} />
      {music.error && (
        <p className="services-error" role="alert">
          {music.error}
        </p>
      )}
    </div>
  );
}

function MusicBody({ meeting, music }: { meeting: Meeting; music: MusicControl }) {
  const { t } = useTranslation();
  const volumes = useStore(meeting.media.volumes);
  const preferences = useStore(meeting.media.preferences);
  /** Ссылка, принесённая с другой площадки, — в поле только что открытой. */
  const [carried, setCarried] = useState('');
  const { state, can, platform, platforms, sources, active, api, yandexApi } = music;
  const yandexOn = sources.includes('yandex') && can('yandex.connect');
  const yandexAccount = useYandexAccount(
    yandexApi,
    meeting.admission.roomId,
    yandexOn && !!state?.enabled && platform === 'yandex',
  );
  const choose = (next: MusicPlatform, text = '') => {
    setCarried(text);
    music.setPlatform(next);
  };

  if (!active) return <p className="music-panel__note">{t(($) => $.services.music.needJoin)}</p>;
  if (music.down)
    return (
      <div role="alert" className="music-panel__problem">
        <p>{t(($) => $.services.music.down)}</p>
        <Button size="sm" onClick={music.retry}>
          {t(($) => $.services.music.retry)}
        </Button>
      </div>
    );
  if (!state)
    return (
      <p role="status" className="music-panel__note">
        {t(($) => $.services.music.connecting)}
      </p>
    );
  if (!state.enabled)
    return (
      <section className="music-intro" aria-labelledby="music-intro-title">
        <span className="music-intro__icon" aria-hidden="true">
          <Music2 size={24} />
        </span>
        <h3 id="music-intro-title">{t(($) => $.services.music.title)}</h3>
        <p>{t(($) => $.services.music.intro, { sources: musicHint(t, sources) })}</p>
        {state.queue.length > 0 && (
          <p className="music-intro__queue">
            {t(($) => $.services.music.queueKept, { count: state.queue.length })}
          </p>
        )}
        {can('music.enable') ? (
          <Button variant="primary" full loading={music.busy} icon={<Music2 />} onClick={music.enable}>
            {t(($) => $.services.music.enable)}
          </Button>
        ) : (
          <p className="music-intro__queue">{t(($) => $.services.music.enableLocked)}</p>
        )}
        {state.error && (
          <p className="services-error" role="alert">
            {state.error}
          </p>
        )}
      </section>
    );

  const canUse = can('music.control');
  const tiles = platformTiles(t, platforms);
  const yandexReady = yandexOn && can('yandex.search');
  /** Чем добавлять на открытой площадке: поле поиска и ссылок, вход Яндекса или зона своих файлов. */
  const adder = !platform ? null : platform !== 'upload' && music.unreachable(platform) ? (
    <Unreachable name={musicSourceName(t, platform)} onRetry={music.retry} />
  ) : platform === 'upload' ? (
    <MusicUpload
      canUse={can('music.upload')}
      maxFileBytes={music.catalog?.maxFileBytes ?? 50 * 1024 * 1024}
      upload={(file, signal) => api.upload(file, signal)}
      onAdded={music.update}
      onError={music.setError}
    />
  ) : (
    <>
      {/* Аккаунт Яндекса — на его площадке, над полем: без аккаунта там искать нечем. */}
      {platform === 'yandex' && yandexOn && (
        <YandexIntegration
          api={yandexApi}
          roomId={meeting.admission.roomId}
          storedToken={preferences.yandexMusicToken}
          onStoredTokenChange={(next) => meeting.media.saveSettings({ yandexMusicToken: next })}
        />
      )}
      {(platform !== 'yandex' || (yandexReady && yandexAccount.data?.connected)) && (
        <MusicSearch
          key={platform}
          abilities={{
            platform,
            offered: platforms,
            canSearch: can('music.search'),
            searchPlatform: api.search,
            addLink: can('music.link') ? api.addLink : null,
            yandex:
              platform === 'yandex' && yandexReady
                ? {
                    connected: !!yandexAccount.data?.connected,
                    search: yandexApi.search,
                    add: can('yandex.queue') ? yandexApi.enqueue : null,
                  }
                : null,
          }}
          initialQuery={carried}
          onSwitch={choose}
          onUnreachable={music.refuse}
          onAdded={music.update}
        />
      )}
    </>
  );

  return (
    <>
      {platform ? (
        <PlatformTabs
          label={t(($) => $.music.platforms.label)}
          tiles={tiles}
          current={platform}
          onPick={(id) => choose(id)}
          down={(id) =>
            id !== 'upload' && music.unreachable(id)
              ? t(($) => $.cinema.reach.unreachable, { name: musicSourceName(t, id) })
              : null
          }
        />
      ) : (
        <p className="music-panel__note">{t(($) => $.music.platforms.none)}</p>
      )}
      {!can('integrations.use') && <p className="music-panel__note">{t(($) => $.services.music.locked)}</p>}
      {/* Добавлять — тем, кому разрешены интеграции; остальным поле только обещало бы отказ. */}
      {can('integrations.use') && adder}
      <MusicPlayer
        state={state}
        canUse={canUse}
        volume={(state.participantId ? volumes[state.participantId] : undefined) ?? 1}
        onVolume={(value) => state.participantId && meeting.media.setVolume(state.participantId, value)}
        onCommand={music.command}
        onSeek={(position) => music.command('seek', { position }, { position })}
        behind={() => meeting.media.musicPlayoutMs()}
      />
      {state.error && (
        <p className="services-error" role="alert">
          {state.error}
        </p>
      )}
      <MusicQueue
        state={state}
        canUse={canUse}
        onClear={(patch) => music.command('clear', undefined, patch)}
        onPromote={(track: MusicTrack, patch) => music.command('next', { trackId: track.id }, patch)}
        onRemove={(track: MusicTrack, patch) => music.command('remove', { trackId: track.id }, patch)}
        onMove={(track: MusicTrack, index, patch) =>
          music.command('move', { trackId: track.id, index }, patch)
        }
      />
      {can('music.remove') && (
        <Button
          variant="quiet"
          className="music-panel__remove"
          icon={<Unplug />}
          loading={music.busy}
          onClick={music.disable}
        >
          {t(($) => $.services.music.remove)}
        </Button>
      )}
    </>
  );
}
