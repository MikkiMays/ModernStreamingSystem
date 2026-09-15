import { lazy, Suspense, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Admission } from './api/types';
import { RoomApi } from './api/client';
import type { Meeting } from './core/meeting';
import { Home, parseInvite, type Destination, type Theme } from './ui/Home';
import { Prejoin } from './ui/Prejoin';
import type { DeviceChoice } from './media/session';
import { getRecent, rememberMeeting, removeRecent, recentMeetings } from './core/recent';
import { notifyDesktop, onDesktopCommand } from './core/desktop';
import { favoriteApi } from './core/favorites';
import { Ping } from './ui/Ping';
import { FavoriteSettings } from './ui/FavoriteSettings';
import type { Favorite } from './core/favorites';
import { savePreferences } from './core/preferences';
import { Connect } from './ui/Connect';
import { Download } from './ui/Download';
import { adopt, session } from './core/session';
import { useStore } from './ui/primitives';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30000, retry: 1, refetchOnWindowFocus: false } },
});
const MeetingView = lazy(() =>
  import('./ui/MeetingView').then((module) => ({ default: module.MeetingView })),
);
function initialDestination() {
  try {
    return parseInvite(location.href);
  } catch {
    return null;
  }
}
function Workspace() {
  const [destination, setDestination] = useState<Destination | null>(initialDestination);
  const [page, setPage] = useState<'home' | 'prejoin' | 'room'>(() =>
    initialDestination() ? 'prejoin' : 'home',
  );
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [error, setError] = useState('');
  const [favoriteSettings, setFavoriteSettings] = useState<Favorite | null>(null);
  const connection = useStore(session);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('cord:theme') as Theme) || 'system');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cord:theme', theme);
  }, [theme]);
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
    history.replaceState(null, '', '/');
  };
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
    document.documentElement.dataset.desktop = String(!!window.chrome?.webview);
    notifyDesktop('state', {
      page,
      inCall: page === 'room' && !!meeting && !meeting.ended.get(),
      name: localStorage.getItem('cord:name') ?? '',
      theme,
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
          if (!favorite) throw new Error('Комната больше не в избранном');
          setDestination({ kind: 'favorite', favorite });
          setPage('prejoin');
        }
      };
      void navigate().catch((e) => setError((e as Error).message));
    });
  }, [page, meeting, theme]);
  const recent = async (id: string, restoring = false) => {
    try {
      const admission = getRecent(id);
      if (!admission) throw new Error('Сессия не найдена');
      admission.snapshot = await new RoomApi(admission).snapshot();
      const self = admission.snapshot.participants.find((p) => p.id === admission.participantId);
      if (admission.snapshot.closedAt || (restoring && self && !sessionStorage.getItem(`cord:ended:${id}`))) {
        await enter(admission, { micOn: false, cameraOn: false });
      } else {
        setDestination({ kind: 'recent', admission });
        setPage('prejoin');
      }
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof Error && 'status' in e && [403, 404, 410].includes(Number(e.status))) removeRecent(id);
    }
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
  if (!connection && page !== 'room')
    return <Connect theme={theme} setTheme={setTheme} onConnected={() => setError('')} />;
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
          onCreate={() => {
            setDestination(null);
            setPage('prejoin');
          }}
          onJoin={openDestination}
        />
      )}
      {page === 'prejoin' && <Prejoin destination={destination} onBack={home} onJoin={enter} />}{' '}
      {page === 'room' && meeting && (
        <Suspense
          fallback={
            <div role="status" className="loading-room">
              Открываем комнату…
            </div>
          }
        >
          <MeetingView
            key={meeting.admission.participantId}
            meeting={meeting}
            onHome={home}
            theme={theme}
            setTheme={setTheme}
          />
        </Suspense>
      )}{' '}
      {error && (
        <div className="global-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setError('')} aria-label="Закрыть уведомление">
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
function Downloads() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('cord:theme') as Theme) || 'system');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('cord:theme', theme);
  }, [theme]);
  return <Download theme={theme} setTheme={setTheme} />;
}

export default function App() {
  if (location.pathname === '/download') return <Downloads />;
  return (
    <QueryClientProvider client={queryClient}>
      <Workspace />
    </QueryClientProvider>
  );
}
