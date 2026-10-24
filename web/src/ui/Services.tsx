import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Meeting } from '../core/meeting';
import { useStore } from './primitives';
import { Button } from './kit';
import { CinemaGroup } from './cinema/CinemaGroup';
import { GamesGroup } from './GamesGroup';
import { TelegramGroup } from './TelegramGroup';
import { IntegrationShelf } from './IntegrationShelf';
import { musicHint, shelfName, type ShelfId } from './integration-shelf';
import { MusicWidget } from './music/MusicWidget';
import { useMusic } from './music/useMusic';
import { gameActivity, musicActivity } from './services-status';

/**
 * Панель интеграций встречи: витрина (`IntegrationShelf`) и внутри — группа.
 *
 * Музыка внутри — сразу плеер (R44): площадки и поиск — вкладками в нём самом (`MusicWidget`), а не
 * отдельным экраном выбора при каждом входе. Тот же плеер открывается и с мини-плеера над звонком
 * (R31). Состояние музыки, команды и права — общим хуком встречи (`useMusic`).
 */
type Group = 'cinema' | 'music' | 'games';
const OPENS: readonly ShelfId[] = ['cinema', 'music', 'games'];

export function Services({ meeting }: { meeting: Meeting }) {
  /**
   * Какая группа открыта. `null` — витрина. Переход между ними не мгновенный: у панели есть
   * короткая анимация появления, иначе подмена содержимого читается как сбой, а не как шаг.
   */
  const { t } = useTranslation();
  const [group, setGroup] = useState<Group | 'telegram' | null>(null);
  const snapshot = useStore(meeting.snapshot);
  const music = useMusic(meeting);
  const { can } = music;
  /**
   * Что во встрече занято прямо сейчас — и что чему мешает.
   *
   * Спорят не все со всеми, а за одно и то же. Кинозал и покер делят **сцену**: там и там
   * смотреть нужно в середину экрана, и вместе они не помещаются. Кинозал и музыка делят
   * **уши**: два звука разом — это не две интеграции, а ни одной. А музыка со столом не спорит
   * вовсе, и играть под неё в карты — ровно то, чего от домашней игры и ждут.
   *
   * Запреты стоят в ядре; здесь они лишь видны заранее, до нажатия.
   */
  const musicStatus = musicActivity(t, music.state, music.down);
  const gamesStatus = gameActivity(t, snapshot.poker, snapshot.durak, snapshot.chess, snapshot.gartic);
  const running: Record<Group, boolean> = {
    cinema: !!snapshot.watch,
    music: musicStatus.active,
    games: gamesStatus.active,
  };
  const RIVALS: Record<Group, Group[]> = {
    cinema: ['music', 'games'],
    music: ['cinema'],
    games: ['cinema'],
  };
  const blockedBy = (group: Group): Group | null =>
    running[group] ? null : (RIVALS[group].find((rival) => running[rival]) ?? null);

  if (!group) {
    const blocked = Object.fromEntries(
      OPENS.map((id) => [id, blockedBy(id as Group)])
        .filter(([, rival]) => rival)
        .map(([id, rival]) => [id, shelfName(t, rival as ShelfId)]),
    );
    return (
      <div className="services-panel" key="groups">
        <IntegrationShelf
          hints={{ music: musicHint(t, music.sources) }}
          live={{
            cinema: running.cinema ? t(($) => $.services.cinemaLive) : undefined,
            music: musicStatus.active ? musicStatus.label : undefined,
            games: gamesStatus.active ? gamesStatus.label : undefined,
          }}
          blockedBy={blocked}
          canLinkTelegram={can('telegram.link')}
          telegramReady={!!music.catalog?.telegram.webapp}
          onOpen={(id) => {
            // Привязка беседы — не интеграция во встрече: с остальными за сцену и звук не спорит.
            if (id === 'telegram') {
              if (can('telegram.link')) setGroup('telegram');
              return;
            }
            if (!(OPENS as readonly string[]).includes(id)) return;
            setGroup(id as Group);
          }}
        />
        {music.error && (
          <p className="services-error" role="alert">
            {music.error}
          </p>
        )}
      </div>
    );
  }

  if (group === 'cinema')
    return (
      <div className="services-panel" key="cinema">
        <CinemaGroup meeting={meeting} onBack={() => setGroup(null)} />
      </div>
    );

  if (group === 'telegram')
    return (
      <div className="services-panel" key="telegram">
        <TelegramGroup meeting={meeting} onBack={() => setGroup(null)} />
      </div>
    );

  if (group === 'games')
    return (
      <div className="services-panel" key="games">
        <GamesGroup meeting={meeting} onBack={() => setGroup(null)} />
      </div>
    );

  return (
    <div className="services-panel music-panel" key="music">
      <Button
        variant="quiet"
        size="sm"
        className="music-panel__back"
        icon={<ArrowLeft />}
        onClick={() => setGroup(null)}
      >
        {t(($) => $.services.music.back)}
      </Button>
      <MusicWidget meeting={meeting} music={music} />
    </div>
  );
}
