import { useState, type CSSProperties, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ArrowLeft, Unplug } from 'lucide-react';
import type { MusicState, MusicTrack, PlatformTrack, YandexApi, YandexTrack } from '../core/services';
import { Button } from './kit';
import { IntegrationShelf } from './IntegrationShelf';
import { MusicPlayer } from './MusicPlayer';
import { MusicQueue } from './MusicQueue';
import { MusicSearch } from './MusicSearch';
import { MusicUpload } from './MusicUpload';
import { YandexIntegration } from './YandexIntegration';
import { t } from '../i18n';
import { musicHint } from './integration-shelf';
import { afterMove } from './music-playback';
import { platformTiles, type MusicPlatform } from './music-platforms';
import { PlatformTabs } from './PlatformPicker';

const PLATFORMS: MusicPlatform[] = ['youtube', 'soundcloud', 'yandex', 'upload'];

/**
 * Витрина и музыка на образцах — для страницы набора `/kit` (E16): без встречи, сервера и сети.
 * Те же компоненты, что в панели встречи, в рамках ширины панели: 320 (самая узкая) и 400 px. Плеер —
 * как в `MusicWidget`: площадки вкладками и поиск внутри, ниже «Сейчас играет» и очередь (R44).
 * Отсюда кадры E06-B на всех ширинах и в обеих темах (`scripts/shots.mjs --screens kit-integrations`)
 * и материал для Figma (E15).
 */
const track = (
  id: string,
  title: string,
  artist: string,
  duration: number,
  source: MusicTrack['source'],
  cover: string | null,
): MusicTrack => ({ id, title, artist, duration, addedBy: 'Аня', source, cover });

const QUEUE: MusicTrack[] = [
  track('n1', 'Ночной город', 'Северные огни', 254, 'youtube', 'sample-1.jpg'),
  track('n2', 'Тихая гавань', 'Лёгкий бриз', 198, 'soundcloud', 'sample-2.jpg'),
  track(
    'n3',
    'Очень длинное название трека, которое не помещается в одну строку панели',
    'Оркестр',
    612,
    'yandex',
    null,
  ),
  track('n4', 'Запись с репетиции', '', 1385, 'upload', null),
  track('n5', 'Утро', 'Кофе и дождь', 171, 'telegram', 'sample-3.jpg'),
];

const STATE: MusicState = {
  roomId: 'kit',
  enabled: true,
  paused: false,
  position: 74,
  revision: 1,
  status: 'playing',
  error: null,
  participantId: 'bot',
  repeat: true,
  queue: QUEUE,
};

const FOUND: Record<PlatformTrack['source'], PlatformTrack[]> = {
  youtube: [
    {
      url: 'y1',
      title: 'Ночной город (official audio)',
      artist: 'Северные огни',
      duration: 213,
      available: true,
      source: 'youtube',
    },
    {
      url: 'y2',
      title: 'Ночной город — живое выступление',
      artist: 'Клуб',
      duration: 342,
      available: true,
      source: 'youtube',
    },
  ],
  soundcloud: [
    {
      url: 's1',
      title: 'Ночной город (remix)',
      artist: 'DJ Полночь',
      duration: 255,
      available: true,
      source: 'soundcloud',
    },
    {
      url: 's2',
      title: 'Ночной город',
      artist: 'Северные огни',
      duration: 30,
      available: false,
      source: 'soundcloud',
    },
  ],
};
const YANDEX: YandexTrack[] = [
  { id: '1', title: 'Ночной город', artist: 'Северные огни', duration: 214, available: true },
];

const yandexApi = {
  status: async () => ({ connected: true, name: 'Музыка Ани' }),
} as unknown as YandexApi;

function Frame({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div className="kit-integrations__frame" style={{ '--frame': `${width}px` } as CSSProperties}>
      <div className="panel-body service-body">{children}</div>
    </div>
  );
}

export function IntegrationsSample({ theme }: { theme: 'light' | 'dark' }) {
  // Своя память запросов: страница набора живёт без общего кэша приложения.
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={client}>
      <Sample theme={theme} />
    </QueryClientProvider>
  );
}

function Sample({ theme }: { theme: 'light' | 'dark' }) {
  const [state, setState] = useState(STATE);
  const now = (patch: Partial<MusicState>) => setState((current) => ({ ...current, ...patch }));
  const added = async () => state;
  // Площадка музыки: вкладки внутри плеера переключают поле, как в панели встречи (R44).
  const [platform, setPlatform] = useState<MusicPlatform>('youtube');
  const tiles = platformTiles(t, PLATFORMS);
  return (
    <div className="kit-integrations">
      <Frame width={320}>
        <div className="services-panel">
          <IntegrationShelf
            hints={{ music: musicHint(t, ['upload', 'yandex', 'youtube', 'soundcloud']) }}
            live={{ music: 'Играет', games: 'Покер: игра идёт' }}
            canLinkTelegram={false}
            onOpen={() => {}}
          />
        </div>
      </Frame>
      <Frame width={400}>
        <div className="services-panel music-panel">
          <Button variant="quiet" size="sm" className="music-panel__back" icon={<ArrowLeft />}>
            Интеграции
          </Button>
          <div className="music-widget">
            <PlatformTabs
              label={t(($) => $.music.platforms.label)}
              tiles={tiles}
              current={platform}
              onPick={setPlatform}
            />
            {platform === 'upload' ? (
              <MusicUpload
                canUse
                maxFileBytes={50 * 1024 * 1024}
                upload={added}
                onAdded={() => {}}
                onError={() => {}}
              />
            ) : (
              <>
                {platform === 'yandex' && (
                  <YandexIntegration
                    api={yandexApi}
                    roomId={`kit-${theme}`}
                    storedToken=""
                    onStoredTokenChange={() => {}}
                  />
                )}
                <MusicSearch
                  key={platform}
                  abilities={{
                    platform,
                    offered: PLATFORMS,
                    canSearch: true,
                    searchPlatform: async (source) => FOUND[source],
                    addLink: added,
                    yandex:
                      platform === 'yandex'
                        ? { connected: true, search: async () => YANDEX, add: added }
                        : null,
                  }}
                  onSwitch={(next) => setPlatform(next)}
                  onAdded={() => {}}
                />
              </>
            )}
            <MusicPlayer
              state={state}
              canUse
              volume={0.72}
              onVolume={() => {}}
              onCommand={(_, __, patch) => patch && now(patch)}
              onSeek={(position) => now({ position })}
            />
            <MusicQueue
              state={state}
              canUse
              onClear={now}
              onPromote={(_, patch) => now(patch)}
              onRemove={(_, patch) => now(patch)}
              onMove={(trackItem, index) => now(afterMove(state, trackItem.id, index))}
            />
            <Button variant="quiet" className="music-panel__remove" icon={<Unplug />}>
              Убрать музыку из встречи
            </Button>
          </div>
        </div>
      </Frame>
    </div>
  );
}
