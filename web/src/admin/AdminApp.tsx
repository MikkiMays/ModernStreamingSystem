import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  Activity,
  BookOpen,
  ChartColumn,
  ChevronRight,
  ClipboardList,
  ExternalLink,
  Flag,
  Gauge,
  Inbox,
  LayoutDashboard,
  LineChart,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  Package,
  Rocket,
  Server,
  ShieldAlert,
  Sun,
  Users,
  Wrench,
} from 'lucide-react';
import { Button, Drawer, Segmented, Select, ToastProvider, useMediaQuery, PHONE_QUERY } from '../ui/kit';
import { text } from '../i18n/admin/ru';
import { FleetError, fleet, type Machine, type Me, type SupportCounts } from './api';
import { Login } from './Login';
import { Skeleton } from './parts';
import { dashboardUrl, NEW_TAB } from './grafana';
import { adminTheme, setAdminTheme, type AdminTheme } from './theme';

const Overview = lazy(() => import('./screens/Overview').then((m) => ({ default: m.Overview })));
const Jobs = lazy(() => import('./screens/Jobs').then((m) => ({ default: m.Jobs })));
const Maintenance = lazy(() => import('./screens/Maintenance').then((m) => ({ default: m.Maintenance })));
const Meetings = lazy(() => import('./screens/Meetings').then((m) => ({ default: m.Meetings })));
const Nodes = lazy(() => import('./screens/Nodes').then((m) => ({ default: m.Nodes })));
const Deploys = lazy(() => import('./screens/Deploys').then((m) => ({ default: m.Deploys })));
const Audit = lazy(() => import('./screens/Audit').then((m) => ({ default: m.Audit })));
const Later = lazy(() => import('./screens/Later').then((m) => ({ default: m.Later })));
const Live = lazy(() => import('./screens/Live').then((m) => ({ default: m.Live })));
const Analytics = lazy(() => import('./screens/Analytics').then((m) => ({ default: m.Analytics })));
const Support = lazy(() => import('./screens/Support').then((m) => ({ default: m.Support })));

export type Section =
  | 'overview'
  | 'live'
  | 'nodes'
  | 'meetings'
  | 'analytics'
  | 'support'
  | 'maintenance'
  | 'deploys'
  | 'security'
  | 'errors'
  | 'metrics'
  | 'flags'
  | 'releases'
  | 'jobs'
  | 'audit';

type Group = 'now' | 'operate' | 'insight' | 'planned';

/**
 * Разделы по задачам владельца (R220): «Сейчас» — что идёт и что горит, «Управление» — рычаги, «Анализ» — что было,
 * «В разработке» — объявленное, но ещё не сделанное (честно отдельно, чтобы не мешало рабочим разделам).
 */
const SECTIONS: { id: Section; icon: ReactNode; group: Group }[] = [
  { id: 'overview', icon: <LayoutDashboard />, group: 'now' },
  { id: 'live', icon: <Gauge />, group: 'now' },
  { id: 'meetings', icon: <Users />, group: 'now' },
  { id: 'support', icon: <Inbox />, group: 'now' },
  { id: 'nodes', icon: <Server />, group: 'operate' },
  { id: 'maintenance', icon: <Wrench />, group: 'operate' },
  { id: 'deploys', icon: <Rocket />, group: 'operate' },
  { id: 'jobs', icon: <ClipboardList />, group: 'operate' },
  { id: 'analytics', icon: <ChartColumn />, group: 'insight' },
  { id: 'audit', icon: <BookOpen />, group: 'insight' },
  { id: 'security', icon: <ShieldAlert />, group: 'planned' },
  { id: 'errors', icon: <Activity />, group: 'planned' },
  { id: 'metrics', icon: <LineChart />, group: 'planned' },
  { id: 'flags', icon: <Flag />, group: 'planned' },
  { id: 'releases', icon: <Package />, group: 'planned' },
];

const GROUPS: Group[] = ['now', 'operate', 'insight', 'planned'];

/** Нижняя полоса телефона: то, что открывают с телефона чаще всего; остальное — «Ещё». */
const TABS: Section[] = ['overview', 'live', 'support', 'meetings'];

/** Разделы, которые показывают ядро выбранной машины, — у них в шапке выбор машины. */
const CORE_SECTIONS = new Set<Section>(['meetings', 'maintenance', 'nodes', 'audit']);

/** Маршрут — первый сегмент пути (`/nodes`, `/jobs/abc`); шлюз отдаёт `admin.html` на любой путь. */
export function parseRoute(pathname: string): { section: Section; rest: string[] } {
  const [first = '', ...rest] = pathname.split('/').filter(Boolean);
  const section = SECTIONS.some((s) => s.id === first) ? (first as Section) : 'overview';
  return { section, rest };
}

export function sectionPath(section: Section): string {
  return section === 'overview' ? '/' : `/${section}`;
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

/** Знак пульта: красная плитка с тремя полосами — тот же, что во вкладке браузера (`icon.svg`). */
export function ConsoleMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="admin-mark"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="48" height="48" rx="11" fill="var(--accent-fill)" />
      <g fill="#fff" transform="translate(9 9)">
        <rect x="2" y="6" width="6" height="18" rx="3" transform="rotate(-15 5 15)" />
        <rect x="12" y="0.5" width="6" height="29" rx="3" transform="rotate(-15 15 15)" />
        <rect x="22" y="4" width="6" height="22" rx="3" transform="rotate(-15 25 15)" />
      </g>
    </svg>
  );
}

function Brand() {
  return (
    <span className="admin-brand">
      <ConsoleMark />
      <span className="admin-brand__text">
        <span className="admin-brand__name">{text.app.console}</span>
        <span className="admin-brand__product">{text.app.product}</span>
      </span>
    </span>
  );
}

function Gate() {
  const client = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => fleet.get<Me>('/auth/me'),
    retry: false,
    refetchInterval: 60_000,
  });
  const signedOut = me.error instanceof FleetError && me.error.status === 401;
  if (me.isPending)
    return (
      <div className="admin-boot">
        <ConsoleMark size={40} />
        <Skeleton rows={2} />
      </div>
    );
  if (signedOut || (me.error && !me.data)) {
    return (
      <div className="admin-login-page">
        <Login onDone={() => void client.invalidateQueries({ queryKey: ['me'] })} brand={<Brand />} />
      </div>
    );
  }
  return <Shell me={me.data!} />;
}

function useAdminTheme(): AdminTheme {
  return useSyncExternalStore(adminTheme.subscribe, adminTheme.get, adminTheme.get);
}

function Shell({ me }: { me: Me }) {
  const client = useQueryClient();
  const [route, setRoute] = useState(() => parseRoute(location.pathname));
  const [menuOpen, setMenuOpen] = useState(false);
  const phone = useMediaQuery(PHONE_QUERY);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);
  const machines = useQuery({ queryKey: ['machines'], queryFn: () => fleet.get<Machine[]>('/machines') });
  // Счётчик обращений в навигации: новые и просроченные видны из любого раздела.
  const counts = useQuery({
    queryKey: ['support-counts'],
    queryFn: () => fleet.get<{ total: SupportCounts; machines: Record<string, unknown> }>('/support/counts'),
    refetchInterval: 60_000,
  });
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
  useEffect(() => {
    document.title = `${text.nav[route.section]} — ${text.app.title}`;
    // Переход по навигации — фокус на заголовок раздела: диктор называет новый раздел, Tab идёт от него.
    if (moved.current) heading.current?.focus({ preventScroll: true });
  }, [route]);
  const go = useCallback((path: string) => {
    history.pushState(null, '', path);
    moved.current = true;
    setRoute(parseRoute(new URL(path, location.href).pathname));
    setMenuOpen(false);
    if (!path.includes('#')) window.scrollTo(0, 0);
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
  const total = counts.data?.total;
  const supportBadge = total ? total.fresh + total.breached : 0;

  const link = (section: Section, variant: 'rail' | 'sheet' | 'tab') => {
    const current = route.section === section;
    const badge = section === 'support' && supportBadge > 0 ? supportBadge : null;
    const label = variant === 'tab' ? (text.navShort[section] ?? text.nav[section]) : text.nav[section];
    const icon = SECTIONS.find((s) => s.id === section)!.icon;
    return (
      <a
        key={section}
        href={sectionPath(section)}
        className={variant === 'tab' ? 'admin-tab' : 'admin-nav__item'}
        aria-current={current ? 'page' : undefined}
        title={variant === 'rail' ? text.nav[section] : undefined}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          go(sectionPath(section));
        }}
      >
        <span className="admin-nav__icon" aria-hidden="true">
          {icon}
        </span>
        <span className="admin-nav__label">{label}</span>
        {badge !== null && (
          <span
            className="admin-count-badge"
            data-tone={total && total.breached > 0 ? 'bad' : undefined}
            aria-label={`${text.overview.supportNew}: ${total?.fresh ?? 0}, ${text.overview.supportBreached}: ${total?.breached ?? 0}`}
          >
            {badge}
          </span>
        )}
      </a>
    );
  };

  const nav = (variant: 'rail' | 'sheet') => (
    <nav className="admin-nav" aria-label={text.app.menu}>
      {GROUPS.map((group) => (
        <div key={group} className="admin-nav__group" data-group={group}>
          <h2 className="admin-nav__heading">{text.navGroups[group]}</h2>
          {SECTIONS.filter((s) => s.group === group).map((s) => link(s.id, variant))}
        </div>
      ))}
    </nav>
  );

  const executor = (
    <span
      className="admin-executor"
      data-live={live || undefined}
      title={
        live ? `${text.app.executorLiveHint} ${me.executor.sshMachines.join(', ')}` : text.app.executorHint
      }
    >
      <span className="admin-executor__dot" aria-hidden="true" />
      {live ? (
        <span>
          {text.app.executorLive}
          <span className="admin-executor__machines">: {me.executor.sshMachines.join(', ')}</span>
        </span>
      ) : (
        <span>{text.app.executorDry}</span>
      )}
    </span>
  );

  const grafana = (
    <a
      className="ui-button ui-button--secondary ui-button--sm admin-grafana"
      href={dashboardUrl()}
      {...NEW_TAB}
      title={text.app.grafanaHint}
    >
      <span className="ui-button__icon" aria-hidden="true">
        <LineChart />
      </span>
      <span className="ui-button__label">{text.app.grafana}</span>
      <ExternalLink className="admin-grafana__out" aria-hidden="true" />
    </a>
  );

  const account = (
    <div className="admin-account">
      <ThemeSwitch />
      <div className="admin-account__row">
        <span className="admin-account__who">
          {text.app.signedInAs}: {me.actor === 'owner' ? text.app.owner : text.app.agent}
        </span>
        <Button variant="quiet" size="sm" icon={<LogOut size={16} />} onClick={() => void signOut()}>
          {text.app.signOut}
        </Button>
      </div>
    </div>
  );

  const context =
    CORE_SECTIONS.has(route.section) && withCore.length > 0 ? (
      <label className="admin-context" title={text.app.coreHint}>
        <span className="admin-context__label">{text.app.core}</span>
        <Select value={machine?.id ?? ''} onChange={(event) => setMachine(event.target.value)}>
          {withCore.map((m) => (
            <option key={m.id} value={m.id}>
              {m.product ? `${m.title} · ${m.product}` : m.title}
            </option>
          ))}
        </Select>
      </label>
    ) : null;

  const jobCrumb = route.section === 'jobs' && route.rest[0];

  return (
    <div className="admin-page" data-phone={phone || undefined}>
      <a className="admin-skip" href="#admin-main">
        {text.app.skip}
      </a>
      {!phone && (
        <aside className="admin-rail" aria-label={text.app.navigation}>
          <div className="admin-rail__brand">
            <Brand />
          </div>
          <div className="admin-rail__scroll">{nav('rail')}</div>
          <div className="admin-rail__foot">{account}</div>
        </aside>
      )}
      <div className="admin-frame">
        <header className="admin-bar">
          {phone && <ConsoleMark />}
          <div className="admin-bar__title">
            {jobCrumb ? (
              <p className="admin-crumb">
                <a
                  href="/jobs"
                  onClick={(event) => {
                    event.preventDefault();
                    go('/jobs');
                  }}
                >
                  {text.nav.jobs}
                </a>
                <ChevronRight size={14} aria-hidden="true" />
              </p>
            ) : null}
            <h1 ref={heading} tabIndex={-1}>
              {jobCrumb ? route.rest[0] : text.nav[route.section]}
            </h1>
          </div>
          {!phone && context}
          <div className="admin-bar__end">
            {executor}
            {!phone && grafana}
          </div>
        </header>
        {phone && context && <div className="admin-context-row">{context}</div>}
        <main className="admin-main" id="admin-main" tabIndex={-1}>
          <Suspense fallback={<Skeleton rows={4} />}>
            <Screen route={route} console={console} />
          </Suspense>
        </main>
      </div>
      {phone && (
        <>
          <nav className="admin-tabbar" aria-label={text.app.quick}>
            {TABS.map((section) => link(section, 'tab'))}
            <button
              type="button"
              className="admin-tab"
              aria-expanded={menuOpen}
              aria-current={!TABS.includes(route.section) ? 'page' : undefined}
              onClick={() => setMenuOpen(true)}
            >
              <span className="admin-nav__icon" aria-hidden="true">
                <MoreHorizontal />
              </span>
              <span className="admin-nav__label">{text.app.more}</span>
            </button>
          </nav>
          <Drawer
            open={menuOpen}
            onOpenChange={setMenuOpen}
            title={text.app.menu}
            height="85"
            closeLabel={text.app.close}
            className="admin-sheet"
          >
            {nav('sheet')}
            <div className="admin-sheet__foot">
              {grafana}
              {account}
            </div>
          </Drawer>
        </>
      )}
    </div>
  );
}

const THEME_ICONS: Record<AdminTheme, ReactNode> = {
  system: <Monitor size={16} />,
  light: <Sun size={16} />,
  dark: <Moon size={16} />,
};

/** Тема пульта — тремя значками с подсказкой: в рельсе слова не помещаются, а значки читаются сразу. */
function ThemeSwitch() {
  const theme = useAdminTheme();
  return (
    <div className="admin-theme">
      <span className="admin-theme__label" id="admin-theme-label">
        {text.app.theme}
      </span>
      <Segmented<AdminTheme>
        size="sm"
        aria-labelledby="admin-theme-label"
        value={theme}
        onValueChange={setAdminTheme}
        options={(['system', 'light', 'dark'] as const).map((value) => ({
          value,
          label: '',
          icon: THEME_ICONS[value],
          ariaLabel: text.app.themes[value],
          title: text.app.themes[value],
        }))}
      />
    </div>
  );
}

function Screen({ route, console }: { route: { section: Section; rest: string[] }; console: Console }) {
  switch (route.section) {
    case 'overview':
      return <Overview console={console} />;
    case 'live':
      return <Live console={console} />;
    case 'analytics':
      return <Analytics console={console} />;
    case 'support':
      return <Support console={console} />;
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
