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
import { savePreferences } from './core/preferences';

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
    history.replaceState(null, '', `/room/${admission.roomId}`);
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
      if (command.type === 'profile.changed' && typeof command.name === 'string') {
        if (meeting) meeting.media.saveSettings({ name: command.name });
        else savePreferences({ name: command.name });
        notifyDesktop('state', {
          page,
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
  return (
    <>
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
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Workspace />
    </QueryClientProvider>
  );
}
