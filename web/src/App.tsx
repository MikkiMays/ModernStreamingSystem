import { lazy, Suspense, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Admission } from './api/types';
import { RoomApi } from './api/client';
import type { Meeting } from './core/meeting';
import { Home, parseInvite, type Destination, type Theme } from './ui/Home';
import { Prejoin } from './ui/Prejoin';
import type { DeviceChoice } from './media/session';
import { getRecent, rememberMeeting, removeRecent, recentMeetings } from './core/recent';
import { isDesktop, notifyDesktop, onDesktopCommand } from './core/desktop';
import { favoriteApi } from './core/favorites';
import { Ping } from './ui/Ping';
import { FavoriteSettings } from './ui/FavoriteSettings';
import type { Favorite } from './core/favorites';
import { readPreferences, savePreferences } from './core/preferences';
import { Connect } from './ui/Connect';
import { Download } from './ui/Download';
import { adopt, greetHostConnection, session } from './core/session';
import { useStore } from './ui/primitives';
import { BootGate } from './ui/loader/BootGate';
import { useMeetingBeacon } from './ui/useMeetingBeacon';
import { findActiveMeeting, requestHandover } from './core/active-meeting';
import { watchTitlebar } from './core/titlebar';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30000, retry: 1, refetchOnWindowFocus: false } },
});
const MeetingView = lazy(() =>
  import('./ui/MeetingView').then((module) => ({ default: module.MeetingView })),
);
// Витрина набора примитивов (E16): без сервера, сессии и кэша — как `/download`.
const Showcase = lazy(() => import('./ui/kit/Showcase').then((module) => ({ default: module.Showcase })));
// «Помощь» (E13): тоже вне приложения — её открывают и тогда, когда Cord не подключается.
const SupportPage = lazy(() =>
  import('./ui/support/SupportPage').then((module) => ({ default: module.SupportPage })),
);
// «Активность» владельца сервера (E10-B) — отдельным чанком: гостям встречи он не нужен.
const Activity = lazy(() =>
  import('./ui/activity/Activity').then((module) => ({ default: module.Activity })),
);
function initialDestination() {
  try {
    return parseInvite(location.href);
  } catch {
    return null;
  }
}
function Workspace() {
  const { t } = useTranslation();
  const [destination, setDestination] = useState<Destination | null>(initialDestination);
  const [page, setPage] = useState<'home' | 'prejoin' | 'room'>(() =>
    initialDestination() ? 'prejoin' : 'home',
  );
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [error, setError] = useState('');
  const [favoriteSettings, setFavoriteSettings] = useState<Favorite | null>(null);
  // «Перейти туда» (T52) ведёт на экран входа в другую встречу: он собирается заново, а не
  // донашивает имя команды и состояние прежнего.
  const [visit, setVisit] = useState(0);
  const [section, setSection] = useState<string | undefined>(undefined);
  const connection = useStore(session);
  useEffect(greetHostConnection, []);
  // Кнопки окна клиента Windows поверх страницы (R34): зона `--titlebar-*`, если `env()` её не дал.
  useEffect(() => (isDesktop() ? watchTitlebar() : undefined), []);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('cord:theme') as Theme) || 'system');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cord:theme', theme);
  }, [theme]);
  // The picture belongs to the page — it is saved per server, beside the name — so the shell
  // can only show what the page tells it. Without this the profile block in the sidebar kept
  // its placeholder no matter what was chosen here.
  const [avatar, setAvatar] = useState(() => readPreferences().avatar);
  useEffect(() => {
    const refresh = () => setAvatar(readPreferences().avatar);
    window.addEventListener('cord:preferences', refresh);
    return () => window.removeEventListener('cord:preferences', refresh);
  }, []);
  const enter = async (
    admission: Admission,
    choices: DeviceChoice & { micOn: boolean; cameraOn: boolean },
  ) => {
    rememberMeeting(admission);
    sessionStorage.removeItem(`cord:ended:${admission.roomId}`);
    const { Meeting } = await import('./core/meeting');
    setMeeting(new Meeting(admission, choices));
    setPage('room');
    // Pushing gives Back a meaning inside the app: one step out of the meeting. Opening
    // /room/<id> directly is already that entry, so re-pushing it would make Back a no-op.
    const path = `/room/${admission.roomId}`;
    if (location.pathname === path) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
  };
  const home = () => {
    meeting?.dispose();
    queryClient.clear();
    setMeeting(null);
    setPage('home');
    // A settings section asked for during the meeting has been dealt with there. Carrying it
    // out of the room made leaving open the settings instead of the home page.
    setSection(undefined);
    history.replaceState(null, '', '/');
  };
  // Соседние вкладки видят встречу этой (T52); забрали её себе — здесь разговор закрывается без
  // выхода из встречи, и главная говорит, где он продолжается.
  useMeetingBeacon(page === 'room' ? meeting : null, () => {
    home();
    setError(t(($) => $.app.elsewhere));
  });
  const openDestination = (next: Destination) => {
    const cached = recentMeetings().find((r) =>
      next.kind === 'code'
        ? r.snapshot.code === next.code
        : next.kind === 'invite' && r.roomId === next.roomId,
    );
    setDestination(cached ? { kind: 'recent', admission: cached } : next);
    setPage('prejoin');
  };
  useEffect(() => {
    document.documentElement.dataset.desktop = String(isDesktop());
    notifyDesktop('state', {
      page,
      inCall: page === 'room' && !!meeting && !meeting.ended.get(),
      name: localStorage.getItem('cord:name') ?? '',
      theme,
      avatar,
      room:
        page === 'room' && meeting
          ? {
              roomId: meeting.admission.roomId,
              title: meeting.admission.snapshot.title,
              code: meeting.admission.snapshot.code,
            }
          : null,
    });
    return onDesktopCommand((command) => {
      if (command.type === 'favorites.changed') {
        void queryClient.invalidateQueries({ queryKey: ['favorites'] });
        return;
      }
      if (command.type === 'preferences.changed') {
        const patch = {
          ...(typeof command.showPing === 'boolean' ? { showPing: command.showPing } : {}),
          ...(typeof command.notificationSounds === 'boolean'
            ? { notificationSounds: command.notificationSounds }
            : {}),
        };
        if (meeting) meeting.media.saveSettings(patch);
        else savePreferences(patch);
        return;
      }
      if (command.type === 'favorite.settings') {
        void favoriteApi
          .list()
          .then((favorites) => {
            const favorite = favorites.find((f) => f.roomId === command.roomId);
            if (favorite) setFavoriteSettings(favorite);
          })
          .catch((e) => setError((e as Error).message));
        return;
      }
      if (command.type === 'profile.changed' && typeof command.name === 'string') {
        if (meeting) meeting.media.saveSettings({ name: command.name });
        else savePreferences({ name: command.name });
        notifyDesktop('state', {
          page,
          inCall: page === 'room' && !!meeting && !meeting.ended.get(),
          name: command.name,
          theme,
          avatar,
          room:
            page === 'room' && meeting
              ? {
                  roomId: meeting.admission.roomId,
                  title: meeting.admission.snapshot.title,
                  code: meeting.admission.snapshot.code,
                }
              : null,
        });
        return;
      }
      if (command.type === 'settings.open') {
        setSection(typeof command.tab === 'string' ? command.tab : 'profile');
        return;
      }
      if (command.type === 'session.token') {
        if (typeof command.token === 'string' && typeof command.expiresAt === 'number')
          adopt({
            token: command.token,
            expiresAt: command.expiresAt,
            name: command.serverName ?? '',
            passwordRequired: true,
          });
        return;
      }
      if (command.type === 'theme.changed') {
        if (command.theme && ['light', 'dark', 'system'].includes(command.theme)) setTheme(command.theme);
        return;
      }
      if (command.type === 'network.changed') {
        window.dispatchEvent(new Event('online'));
        return;
      }
      if (command.type === 'deeplink') {
        // `cord://room/<код>` — как ввод кода на главной. Приглашение без токена открыть нечем.
        if (typeof command.code === 'string' && /^\d{9}$/.test(command.code))
          openDestination({ kind: 'code', code: command.code });
        return;
      }
      const navigate = async () => {
        if (command.type === 'close-request') {
          try {
            await meeting?.leave();
          } finally {
            meeting?.dispose();
            notifyDesktop('close-ready');
          }
          return;
        }
        if (command.type !== 'navigate') return;
        if (command.page === 'favorite' && (!command.roomId || !/^[0-9a-f-]{36}$/.test(command.roomId)))
          return;
        if (meeting) void meeting.leave();
        home();
        if (command.page === 'create') {
          setDestination(null);
          setPage('prejoin');
        }
        if (command.page === 'favorite') {
          const favorite = (await favoriteApi.list()).find((f) => f.roomId === command.roomId);
          if (!favorite) throw new Error(t(($) => $.app.notFavorite));
          setDestination({ kind: 'favorite', favorite });
          setPage('prejoin');
        }
      };
      void navigate().catch((e) => setError((e as Error).message));
    });
  }, [page, meeting, theme, avatar]);
  /** Открыть недавнюю встречу; `false` — открыть не вышло (ошибка уже показана). */
  const recent = async (id: string, restoring = false, quiet = false) => {
    try {
      const admission = getRecent(id);
      if (!admission) throw new Error(t(($) => $.app.noSession));
      admission.snapshot = await new RoomApi(admission).snapshot();
      const self = admission.snapshot.participants.find((p) => p.id === admission.participantId);
      if (admission.snapshot.closedAt || (restoring && self && !sessionStorage.getItem(`cord:ended:${id}`))) {
        await enter(admission, { micOn: false, cameraOn: false });
      } else {
        setDestination({ kind: 'recent', admission });
        setPage('prejoin');
      }
      return true;
    } catch (e) {
      if (!quiet) setError((e as Error).message);
      if (e instanceof Error && 'status' in e && [403, 404, 410].includes(Number(e.status))) removeRecent(id);
      return false;
    }
  };
  /**
   * «Перейти туда» из окна «Вы уже во встрече…» (T52): ядро назвало встречу, где этот профиль уже
   * есть. Дороги туда, по порядку:
   *
   * 1. Соседняя вкладка этого браузера (`core/active-meeting.ts`): встреча переносится сюда тем же
   *    участником, как «Вернуться» на главной, — та вкладка отпускает разговор без выхода.
   * 2. Прежний вход этой вкладки (недавние, `sessionStorage`) — через экран входа и повторный вход
   *    (`restoring` не ставится): та же сессия в двух местах сразу означала бы один участник SFU на
   *    двоих, а повторный вход заменяет прежнюю сессию честно.
   * 3. Избранное — тем же повторным входом.
   *
   * Нет ни одной — в этом браузере встреча не открыта, и экран входа скажет об этом сам (`false`).
   */
  const goElsewhere = async ({ roomId }: { roomId: string }) => {
    const tab = await findActiveMeeting(roomId);
    if (tab) {
      const admission = await requestHandover(tab);
      rememberMeeting(admission);
      if (await recent(admission.roomId, true, true)) {
        setVisit((value) => value + 1);
        return true;
      }
    }
    if (getRecent(roomId) && (await recent(roomId, false, true))) {
      setVisit((value) => value + 1);
      return true;
    }
    const favorite = (await favoriteApi.list()).find((f) => f.roomId === roomId);
    if (!favorite) return false;
    setVisit((value) => value + 1);
    setDestination({ kind: 'favorite', favorite });
    setPage('prejoin');
    return true;
  };
  useEffect(() => {
    const match = /^\/room\/([0-9a-f-]{36})$/.exec(location.pathname);
    if (match?.[1]) void recent(match[1], true);
  }, []);
  // The address bar is part of the state here. Previously it was rewritten but never read
  // back, so Back moved the URL while the view stayed put and the two disagreed. Leaving on
  // Back matches what the exit button in the meeting already does.
  useEffect(() => {
    const reconcile = () => {
      const roomId = /^\/room\/([0-9a-f-]{36})$/.exec(location.pathname)?.[1];
      if (roomId) {
        if (page !== 'room' || meeting?.admission.roomId !== roomId) void recent(roomId, true);
        return;
      }
      if (page === 'room') {
        if (meeting) void meeting.leave();
        home();
      }
    };
    window.addEventListener('popstate', reconcile);
    return () => window.removeEventListener('popstate', reconcile);
  });
  // Nothing about meetings before the server has answered. A meeting already open is the one
  // exception: a session that lapses mid-conversation must never take the conversation away.
  if (!connection && page !== 'room') return <Connect onConnected={() => setError('')} />;
  return (
    <>
      {page !== 'room' && <Ping />}
      {favoriteSettings && (
        <FavoriteSettings
          key={favoriteSettings.roomId}
          room={favoriteSettings}
          initiallyOpen
          removing={false}
          remove={async () => {
            await favoriteApi.remove(favoriteSettings.roomId);
            await queryClient.invalidateQueries({ queryKey: ['favorites'] });
          }}
          onClose={() => setFavoriteSettings(null)}
        />
      )}
      {page === 'home' && (
        <Home
          theme={theme}
          setTheme={setTheme}
          section={section}
          onSectionClosed={() => setSection(undefined)}
          onCreate={() => {
            setDestination(null);
            setPage('prejoin');
          }}
          onJoin={openDestination}
          onResume={(admission) => {
            // Встреча из соседней вкладки (T52): та вкладка её отпустила, этот же участник
            // продолжает здесь — как после перезагрузки страницы.
            rememberMeeting(admission);
            void recent(admission.roomId, true);
          }}
        />
      )}
      {page === 'prejoin' && (
        <Prejoin
          key={visit}
          destination={destination}
          onBack={home}
          onJoin={enter}
          onElsewhere={goElsewhere}
        />
      )}{' '}
      {page === 'room' && meeting && (
        <Suspense
          fallback={
            <div role="status" className="loading-room">
              {t(($) => $.app.opening)}
            </div>
          }
        >
          <MeetingView
            key={meeting.admission.participantId}
            meeting={meeting}
            onHome={home}
            theme={theme}
            setTheme={setTheme}
            section={section}
            onSectionClosed={() => setSection(undefined)}
          />
        </Suspense>
      )}{' '}
      {error && (
        <div className="global-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError('')} aria-label={t(($) => $.app.closeNotice)}>
            ×
          </button>
        </div>
      )}
    </>
  );
}
/**
 * Getting the client is not part of using one. `/download` therefore stands outside the
 * application entirely: no server session, no room, no query cache — somebody who was handed
 * the address should be able to fetch Cord before they have a password or an invitation.
 */
function useSavedTheme() {
  // Тему здесь не выбирают (T41: она в настройках), но выбранную в приложении — показывают.
  useEffect(() => {
    document.documentElement.dataset.theme = localStorage.getItem('cord:theme') || 'system';
  }, []);
}
function Downloads() {
  useSavedTheme();
  return <Download />;
}
function Support() {
  useSavedTheme();
  return <SupportPage />;
}

export default function App() {
  // `BootGate` стоит рядом с экраном, а не над ним: статичная загрузка гаснет после кадра
  // самого экрана, а не после кадра пустой обёртки, пока ленивый чанк ещё едет.
  if (location.pathname === '/download')
    return (
      <>
        <Downloads />
        <BootGate />
      </>
    );
  if (location.pathname === '/support')
    return (
      <Suspense fallback={null}>
        <Support />
        <BootGate />
      </Suspense>
    );
  // Страница владельца сервера (E10-B): своя дверь — пароль владельца, без сессии встречи и кэша.
  if (location.pathname === '/activity')
    return (
      <Suspense fallback={null}>
        <Activity />
        <BootGate />
      </Suspense>
    );
  if (location.pathname === '/kit')
    return (
      <Suspense fallback={null}>
        <Showcase />
        <BootGate />
      </Suspense>
    );
  return (
    <QueryClientProvider client={queryClient}>
      <Workspace />
      <BootGate />
    </QueryClientProvider>
  );
}
