import { Track } from 'livekit-client';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { hasFeature, notifyDesktop, onDesktopEvent } from '../core/desktop';
import { desktopCaptureAudio, selectCaptureSource, type CaptureAudio } from '../core/desktop-capture';
import type { Meeting } from '../core/meeting';
import { humans, presentHumans } from '../core/people';
import { Store } from '../core/store';
import type { Panel } from './Sidebar';

/**
 * Встреча для окон оболочки Windows поверх других программ (R63, R93, R104): виджет говорящих в игре
 * и мини-окно звонка.
 *
 * Что уходит оболочке:
 * - `overlay.roster` — кто во встрече: id, имя, аватар (`data:`, ≤ 4 КиБ) и выключен ли микрофон;
 *   только когда состав изменился;
 * - `overlay.levels` — ступень и уровень голоса каждого при каждом изменении (до 30 раз в секунду, без
 *   прежнего дросселя 100 мс). Это сообщение preload кладёт прямо в порты окон оболочки, мимо main;
 *   измеритель в клиенте — `AudioWorklet` (`media/levels.ts`): он работает, и когда Cord спрятан;
 * - `mini.state` — название встречи, микрофон, камера, показ, непрочитанные, сколько людей и связь со
 *   звуком (`status`: идёт или восстанавливается, `remaining` — сколько секунд ещё ждать); сразу, как
 *   что-то поменялось. Пока связь восстанавливается, нажатия микрофона, камеры и показа встреча не
 *   исполняет (как пульт) — мини-окно по `status` гасит эти кнопки, а не принимает их впустую.
 * Оболочка до R63 (без флага `overlay.widget`) получает прежнее `overlay.state` — имена и ступени
 * без аватаров, не чаще 10 раз в секунду.
 *
 * Что приходит: `mini.action {id}` — нажатие в мини-окне (микрофон, камера, показ, участники, чат,
 * настройки, выход) и `golive {id, name}` — «Показать игру»: показ окна игры с тем же качеством, что
 * выбрано в окне показа, в режиме «Плавность» и со звуком игры. Жест для `getDisplayMedia` оболочка
 * дала странице сама, поэтому показ начинается без окна выбора.
 */
export interface DesktopOverlayActions {
  setPanel: (panel: Panel) => void;
  openSettings: () => void;
  leave: () => void;
}

/** «Показать экран» из мини-окна: пульт открывает своё окно выбора (`CallDock`). */
export const shareRequests = new Store(0);

/** Предел виджета — как у оболочки (`ROSTER_SIZE` в `messages.ts`). */
const ROSTER_SIZE = 25;
const AVATAR_LIMIT = 4096;

export function useDesktopOverlay(meeting: Meeting, ended: boolean, actions: DesktopOverlayActions) {
  const latest = useRef(actions);
  useLayoutEffect(() => {
    latest.current = actions;
  });

  // Состав и уровни голоса — виджету в игре и мини-окну.
  useEffect(() => {
    if (ended || !hasFeature('overlay')) return;
    if (!hasFeature('overlay.widget') && !hasFeature('mini')) return legacyOverlay(meeting);
    let sent = '';
    let ids: string[] = [];
    const roster = () => {
      const self = meeting.admission.participantId;
      const microphone = meeting.media.state.get().microphone;
      const speakingTracks = new Set(
        meeting.media.tracks
          .get()
          .filter((tile) => tile.source === Track.Source.Microphone && !tile.muted)
          .map((tile) => tile.participantId),
      );
      const participants = presentHumans(meeting.snapshot.get().participants)
        .slice(0, ROSTER_SIZE)
        .map((person) => ({
          id: person.id,
          name: person.name.slice(0, 40),
          // У человека без картинки ядро шлёт null (`RoomState.Member.avatar`), хоть схема и пишет string.
          avatar:
            typeof person.avatar === 'string' &&
            person.avatar.startsWith('data:image/') &&
            person.avatar.length <= AVATAR_LIMIT
              ? person.avatar
              : '',
          muted: person.id === self ? !microphone : !speakingTracks.has(person.id),
        }));
      const next = JSON.stringify(participants);
      if (next === sent) return;
      sent = next;
      ids = participants.map((person) => person.id);
      notifyDesktop('overlay.roster', { participants });
      levels();
    };
    const levels = () => {
      const state = meeting.media.levels.state.get();
      notifyDesktop('overlay.levels', {
        levels: ids.flatMap((id) => (state[id] ? [[id, state[id].tier, state[id].level]] : [])),
      });
    };
    const stops = [
      meeting.snapshot.subscribe(roster),
      meeting.media.tracks.subscribe(roster),
      meeting.media.state.subscribe(roster),
      meeting.media.levels.watchAll(levels),
    ];
    roster();
    return () => {
      stops.forEach((stop) => stop());
      notifyDesktop('overlay.roster', { participants: [] });
    };
  }, [meeting, ended]);

  // Мини-окно звонка: что показывать.
  useEffect(() => {
    if (ended || !hasFeature('mini')) return;
    let sent = '';
    const publish = () => {
      const media = meeting.media.state.get();
      const state = {
        room: meeting.admission.snapshot.title.slice(0, 80),
        self: meeting.admission.participantId,
        mic: media.microphone,
        camera: media.camera,
        screen: media.screen,
        unread: meeting.unread.get(),
        count: presentHumans(meeting.snapshot.get().participants).length,
        status: media.status === 'connected' || media.status === 'recovering' ? media.status : 'connecting',
        remaining: media.status === 'recovering' ? Math.max(0, Math.ceil(media.remaining)) : 0,
      };
      const next = JSON.stringify(state);
      if (next === sent) return;
      sent = next;
      notifyDesktop('mini.state', state);
    };
    const stops = [
      meeting.media.state.subscribe(publish),
      meeting.unread.subscribe(publish),
      meeting.snapshot.subscribe(publish),
    ];
    publish();
    return () => stops.forEach((stop) => stop());
  }, [meeting, ended]);

  // Нажатия в мини-окне и «Показать игру».
  useEffect(() => {
    if (ended) return;
    const live = () => !meeting.ended.get() && meeting.media.state.get().status === 'connected';
    const stops = [
      onDesktopEvent('mini.action', ({ id }) => {
        switch (id) {
          case 'mic':
            if (live()) void meeting.media.toggle('microphone');
            return;
          case 'camera':
            if (live()) void meeting.media.toggle('camera');
            return;
          case 'screen':
            if (!live()) return;
            if (meeting.media.state.get().screen) void meeting.media.stopScreen();
            else shareRequests.update((count) => count + 1);
            return;
          case 'people':
          case 'chat':
            latest.current.setPanel(id);
            return;
          case 'settings':
            latest.current.openSettings();
            return;
          case 'leave':
            latest.current.leave();
            return;
        }
      }),
      onDesktopEvent('golive', ({ id }) => {
        if (
          typeof id !== 'string' ||
          !/^window:\d+:\d+$/.test(id) ||
          !live() ||
          meeting.media.state.get().screen
        )
          return;
        // Игра — «Плавность» и частота 60 (DESIGN.md → Оверлей); разрешение — как выбрано в окне показа.
        const profile = {
          ...meeting.media.preferences.get().screen,
          mode: 'smooth' as const,
          fps: 60 as const,
        };
        const audio: CaptureAudio = hasFeature('capture.app-audio') ? 'app' : 'none';
        void selectCaptureSource(id, audio).then(() =>
          meeting.media.share(profile, desktopCaptureAudio(audio)),
        );
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, [meeting, ended]);
}

/** Оболочка до R63: имена и ступени без аватаров — не чаще 10 раз в секунду (T23, E01). */
function legacyOverlay(meeting: Meeting): () => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const publish = () => {
    timer = null;
    last = Date.now();
    const levels = meeting.media.levels.state.get();
    const speaking = new Set(meeting.media.speaking.get());
    notifyDesktop('overlay.state', {
      participants: humans(meeting.snapshot.get().participants)
        .slice(0, 20)
        .map((p) => ({
          name: p.name.slice(0, 40),
          tier: levels[p.id]?.tier ?? 0,
          speaking: speaking.has(p.id),
        })),
    });
  };
  const schedule = () => {
    if (timer) return;
    const wait = Math.max(0, 100 - (Date.now() - last));
    timer = setTimeout(publish, wait);
  };
  const stops = [meeting.media.levels.watchAll(schedule), meeting.snapshot.subscribe(schedule)];
  schedule();
  return () => {
    stops.forEach((stop) => stop());
    if (timer) clearTimeout(timer);
    notifyDesktop('overlay.state', { participants: [] });
  };
}
