import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  BookOpen,
  ClipboardList,
  Flag,
  LayoutDashboard,
  LineChart,
  LogOut,
  Menu as MenuIcon,
  Package,
  Rocket,
  Server,
  ShieldAlert,
  Users,
  Wrench,
} from 'lucide-react';
import {
  Button,
  Drawer,
  IconButton,
  Logo,
  Select,
  ToastProvider,
  useMediaQuery,
  PHONE_QUERY,
} from '../ui/kit';
import { text } from '../i18n/admin/ru';
import { FleetError, fleet, type Machine, type Me } from './api';
import { Login } from './Login';
import { Skeleton } from './parts';

const Overview = lazy(() => import('./screens/Overview').then((m) => ({ default: m.Overview })));
const Jobs = lazy(() => import('./screens/Jobs').then((m) => ({ default: m.Jobs })));
const Maintenance = lazy(() => import('./screens/Maintenance').then((m) => ({ default: m.Maintenance })));
const Meetings = lazy(() => import('./screens/Meetings').then((m) => ({ default: m.Meetings })));
const Nodes = lazy(() => import('./screens/Nodes').then((m) => ({ default: m.Nodes })));
const Deploys = lazy(() => import('./screens/Deploys').then((m) => ({ default: m.Deploys })));
const Audit = lazy(() => import('./screens/Audit').then((m) => ({ default: m.Audit })));
const Later = lazy(() => import('./screens/Later').then((m) => ({ default: m.Later })));

export type Section =
  | 'overview'
  | 'nodes'
  | 'meetings'
  | 'maintenance'
  | 'deploys'
  | 'security'
  | 'errors'
  | 'metrics'
  | 'flags'
  | 'releases'
  | 'jobs'
  | 'audit';

const SECTIONS: { id: Section; icon: ReactNode }[] = [
  { id: 'overview', icon: <LayoutDashboard size={20} /> },
  { id: 'nodes', icon: <Server size={20} /> },
  { id: 'meetings', icon: <Users size={20} /> },
  { id: 'maintenance', icon: <Wrench size={20} /> },
  { id: 'deploys', icon: <Rocket size={20} /> },
  { id: 'security', icon: <ShieldAlert size={20} /> },
  { id: 'errors', icon: <Activity size={20} /> },
  { id: 'metrics', icon: <LineChart size={20} /> },
  { id: 'flags', icon: <Flag size={20} /> },
  { id: 'releases', icon: <Package size={20} /> },
  { id: 'jobs', icon: <ClipboardList size={20} /> },
  { id: 'audit', icon: <BookOpen size={20} /> },
];

/** Маршрут — первый сегмент пути (`/nodes`, `/jobs/abc`); шлюз отдаёт `admin.html` на любой путь. */
export function parseRoute(pathname: string): { section: Section; rest: string[] } {
  const [first = '', ...rest] = pathname.split('/').filter(Boolean);
  const section = SECTIONS.some((s) => s.id === first) ? (first as Section) : 'overview';
  return { section, rest };
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof FleetError) && count < 2,
      staleTime: 5_000,
      refetchOnWindowFocus: true,
    },
  },
});

export function AdminApp() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Gate />
      </ToastProvider>
    </QueryClientProvider>
  );
}

/** Контекст пульта для экранов: кто вошёл, машины, выбранная машина-ядро, переход между разделами. */
export type Console = {
  me: Me;
  machines: Machine[];
  /** Машина-контекст для разделов ядра (встречи, окно работ, безопасность). */
  machine: Machine | null;
  setMachine: (id: string) => void;
  go: (path: string) => void;
  signOut: () => void;
};

function Gate() {
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => fleet.get<Me>('/auth/me'),
    retry: false,
    refetchInterval: 60_000,
  });
  useEffect(() => {
    document.title = text.app.title;
  }, []);
  const signedOut = me.error instanceof FleetError && me.error.status === 401;
  if (me.isPending) return <Skeleton rows={4} />;
  if (signedOut || (me.error && !me.data)) {
    return (
      <div className="admin-page admin-page--login">
        <header className="admin-header">
          <Logo />
          <h1>{text.app.title}</h1>
        </header>
        <Login onDone={() => void client.invalidateQueries({ queryKey: ['me'] })} />
      </div>
    );
  }
  return <Shell me={me.data!} />;
}

function Shell({ me }: { me: Me }) {
  const client = useQueryClient();
  const [route, setRoute] = useState(() => parseRoute(location.pathname));
  const [menuOpen, setMenuOpen] = useState(false);
  const phone = useMediaQuery(PHONE_QUERY);
  const machines = useQuery({ queryKey: ['machines'], queryFn: () => fleet.get<Machine[]>('/machines') });
  const [machineId, setMachineId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('cord:fleet:machine');
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = useCallback((path: string) => {
    history.pushState(null, '', path);
    setRoute(parseRoute(path));
    setMenuOpen(false);
    window.scrollTo(0, 0);
  }, []);
  const signOut = useCallback(async () => {
    try {
      await fleet.post('/auth/logout');
    } finally {
      // Данные экранов — долой (следующий владелец их не увидит), а `me` перечитывается: 401 → форма входа.
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
      await client.invalidateQueries({ queryKey: ['me'] });
    }
  }, [client]);
  const withCore = (machines.data ?? []).filter((m) => m.core?.credential);
  const machine = withCore.find((m) => m.id === machineId) ?? withCore[0] ?? null;
  const setMachine = (id: string) => {
    setMachineId(id);
    try {
      localStorage.setItem('cord:fleet:machine', id);
    } catch {
      /* без памяти выбора */
    }
  };
  const console: Console = { me, machines: machines.data ?? [], machine, setMachine, go, signOut };
  const live = me.executor.mode === 'ssh' && me.executor.sshMachines.length > 0;

  const nav = (
    <nav className="admin-nav" aria-label={text.app.menu}>
      {SECTIONS.map((section) => (
        <a
          key={section.id}
          href={`/${section.id === 'overview' ? '' : section.id}`}
          className="admin-nav__item"
          aria-current={route.section === section.id ? 'page' : undefined}
          onClick={(event) => {
            event.preventDefault();
            go(`/${section.id === 'overview' ? '' : section.id}`);
          }}
        >
          <span className="admin-nav__icon" aria-hidden="true">
            {section.icon}
          </span>
          {text.nav[section.id]}
        </a>
      ))}
    </nav>
  );

  return (
    <div className="admin-page">
      <header className="admin-header">
        {phone && (
          <IconButton label={text.app.menu} onClick={() => setMenuOpen(true)}>
            <MenuIcon size={20} />
          </IconButton>
        )}
        <Logo />
        <h1>{text.nav[route.section]}</h1>
        {withCore.length > 0 && (
          <label className="admin-machine">
            <span>{text.app.machine}</span>
            <Select value={machine?.id ?? ''} onChange={(event) => setMachine(event.target.value)}>
              {withCore.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.product ? `${m.title} · ${m.product}` : m.title}
                </option>
              ))}
            </Select>
          </label>
        )}
        <span
          className="admin-executor"
          data-live={live || undefined}
          title={
            live
              ? `${text.app.executorLiveHint} ${me.executor.sshMachines.join(', ')}`
              : text.app.executorHint
          }
        >
          {live ? `${text.app.executorLive}: ${me.executor.sshMachines.join(', ')}` : text.app.executorDry}
        </span>
        <span className="admin-actor">{me.actor === 'owner' ? text.app.owner : text.app.agent}</span>
        <Button variant="quiet" size="sm" icon={<LogOut size={16} />} onClick={() => void signOut()}>
          {text.app.signOut}
        </Button>
      </header>
      <div className="admin-body">
        {phone ? (
          <Drawer open={menuOpen} onOpenChange={setMenuOpen} title={text.app.menu}>
            {nav}
          </Drawer>
        ) : (
          <aside className="admin-side">{nav}</aside>
        )}
        <main className="admin-main">
          <Suspense fallback={<Skeleton rows={4} />}>
            <Screen route={route} console={console} />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

function Screen({ route, console }: { route: { section: Section; rest: string[] }; console: Console }) {
  switch (route.section) {
    case 'overview':
      return <Overview console={console} />;
    case 'jobs':
      return <Jobs console={console} jobId={route.rest[0]} />;
    case 'maintenance':
      return <Maintenance console={console} />;
    case 'meetings':
      return <Meetings console={console} />;
    case 'nodes':
      return <Nodes console={console} />;
    case 'deploys':
      return <Deploys console={console} />;
    case 'audit':
      return <Audit console={console} />;
    default:
      return <Later section={route.section} />;
  }
}
