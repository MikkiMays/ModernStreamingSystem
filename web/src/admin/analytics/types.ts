/**
 * Отчёты службы `insight` (R239) — зеркало `contracts/insight-reports.md`. Форму ведёт служба: правка — там, в
 * образцах `contracts/fixtures/insight/*.json` и здесь одним коммитом (тест `analytics.test.tsx` рисует каждый
 * раздел по образцу).
 */
export type View = 'period' | 'cohort';

export type Section =
  | 'pulse'
  | 'audience'
  | 'acquisition'
  | 'activation'
  | 'retention'
  | 'engagement'
  | 'integrations'
  | 'quality'
  | 'errors'
  | 'traffic';

export interface Range {
  from: string;
  to: string;
  days: number;
}

export interface Report<T> {
  section: string;
  range: Range;
  view: View;
  strict: boolean;
  zone: string;
  generated_at: string;
  data: T;
  previous?: { range: Range; data: T };
}

export interface Tile {
  value: number | null;
  previous: number | null;
  change: number | null;
}

export type PulseTile =
  | 'people'
  | 'new_people'
  | 'returning'
  | 'resurrected'
  | 'interlocutors'
  | 'weekly_interlocutors'
  | 'interlocutor_share'
  | 'confirmed'
  | 'engaged_only'
  | 'talk_hours'
  | 'join_success'
  | 'join_p50_ms'
  | 'error_free_sessions'
  | 'vpn_share'
  | 'stickiness';

export interface Pulse {
  tiles: Record<PulseTile, Tile>;
  series: {
    day: string;
    people: number;
    new_people: number;
    interlocutors: number;
    talk_hours: number;
    weekly_interlocutors: number;
  }[];
}

export interface Frequency {
  active_days: number;
  people: number;
}

export interface Breakdown {
  key: string;
  people: number;
  sessions: number;
}

export interface Audience {
  totals: {
    people: number;
    new_people: number;
    returning: number;
    resurrected: number;
    recognised_by_fingerprint: number;
    confirmed: number;
    engaged_only: number;
    sessions: number;
    sessions_per_person: number | null;
    vpn_sessions: number;
    vpn_share: number | null;
    stickiness: number | null;
  };
  series: {
    day: string;
    dau: number;
    wau: number;
    mau: number;
    new_people: number;
    returning: number;
    resurrected: number;
    stickiness: number | null;
  }[];
  frequency: Frequency[];
  recognised: { cookie: number; profile: number; fingerprint: number; new: number };
  by_client: Breakdown[];
  by_os: Breakdown[];
  by_browser: Breakdown[];
  by_device: Breakdown[];
  by_country: Breakdown[];
  by_network: Breakdown[];
}

export interface Source {
  key: string;
  new_people: number;
  interlocutors: number;
  share: number | null;
}

export interface Acquisition {
  totals: {
    new_people: number;
    by_invite: number;
    invite_share: number | null;
    interlocutors: number;
    invites_sent: number;
    inviters: number;
    k_factor: number | null;
  };
  by_landing: Source[];
  by_source: Source[];
  by_campaign: Source[];
  by_client: Source[];
  by_os: Source[];
  by_country: Source[];
  invites: { how: string; count: number }[];
  series: { day: string; new_people: number; by_invite: number }[];
}

export type Step = 'open' | 'engaged' | 'prejoin' | 'permission' | 'join' | 'media' | 'talk';

export interface Activation {
  new_people: number;
  activated_24h: number;
  activated_7d: number;
  mature_24h: number;
  mature_7d: number;
  share_24h: number | null;
  share_7d: number | null;
  funnel: { step: Step; people: number; share: number | null }[];
  time_to_talk: { bucket: string; people: number }[];
  permissions: { device: string; result: string; count: number }[];
  series: { day: string; new_people: number; activated_24h: number; activated_7d: number }[];
}

export interface Kept {
  eligible: number;
  returned: number;
  share: number | null;
  talked: number;
  talked_share: number | null;
}

export interface Cohort {
  size: number;
  d1: Kept;
  d7: Kept;
  d30: Kept;
}

export interface Retention {
  bucket: 'day' | 'week' | 'month';
  total: Cohort;
  cohorts: (Cohort & { cohort: string })[];
  curve: {
    age: number;
    eligible: number;
    active: number;
    share: number | null;
    talked: number;
    talked_share: number | null;
  }[];
  carried: { previous_people: number; stayed: number; share: number | null };
}

export interface Engagement {
  totals: {
    people: number;
    interlocutors: number;
    talk_hours: number;
    together_hours: number;
    minutes_per_interlocutor_day: number | null;
    sessions: number;
    sessions_per_person: number | null;
    joins: number;
    mic_hours: number;
    cam_hours: number;
    screen_hours: number;
    integration_hours: { cinema: number; music: number; game: number; board: number };
  };
  meetings: {
    count: number;
    with_peers: number;
    median_minutes: number | null;
    p90_minutes: number | null;
    peak_avg: number | null;
    person_hours: number;
  };
  series: {
    day: string;
    talk_hours: number;
    interlocutors: number;
    minutes_per_interlocutor: number | null;
    meetings: number;
  }[];
  frequency: Frequency[];
  meeting_sizes: { bucket: string; meetings: number }[];
  meeting_lengths: { bucket: string; meetings: number }[];
  features: { name: string; count: number; sessions: number }[];
  screens: { name: string; count: number }[];
  leave_reasons: { reason: string; count: number }[];
  drop_reasons: { reason: string; count: number }[];
}

export interface IntegrationRow {
  runs: number;
  people: number;
  meetings: number;
  meeting_share: number | null;
  watch_hours: number;
  avg_minutes: number | null;
  median_minutes: number | null;
  peak_avg: number | null;
  bytes: number;
  stream_hours: number;
  bytes_per_hour: number | null;
  errors: number;
  stalls: number;
  stall_seconds: number;
}

export interface Integrations {
  totals: IntegrationRow;
  by_kind: (IntegrationRow & { kind: string })[];
  by_variant: (IntegrationRow & { kind: string; variant: string })[];
  series: { day: string; cinema: number; music: number; game: number; board: number; watch_hours: number }[];
  errors: { kind: string; variant: string; code: string; count: number }[];
  close_reasons: { kind: string; reason: string; runs: number }[];
}

export interface Timing {
  samples: number;
  p50_ms: number | null;
  p95_ms: number | null;
  signal_p50_ms: number | null;
  media_p50_ms: number | null;
}

export interface Media {
  meetings: number;
  person_hours: number;
  summaries: number;
  loss_avg: number | null;
  rtt_avg_ms: number | null;
  relay_share: number | null;
  freezes: number;
  freezes_per_hour: number | null;
  reconnects: number;
  reconnects_per_hour: number | null;
  node_moves: number;
}

export interface Quality {
  join: {
    attempts: number;
    joined: number;
    failed: number;
    success: number | null;
    by_how: { how: string; count: number }[];
    by_node: { node: string; joined: number }[];
    failures: { code: string; count: number; share: number | null }[];
  };
  join_time: { total: Timing; by_node: (Timing & { node: string })[] };
  sessions: {
    total: number;
    without_errors: number;
    error_free_share: number | null;
    vpn: number;
    vpn_share: number | null;
  };
  media: { total: Media; by_node: (Media & { node: string })[] };
  drops: { reason: string; count: number }[];
  refusals: { code: string; count: number }[];
  networks: {
    net: string;
    sessions: number;
    people: number;
    vpn_share: number | null;
    error_free_share: number | null;
  }[];
  series: {
    day: string;
    joined: number;
    failed: number;
    success: number | null;
    error_free_share: number | null;
    vpn_share: number | null;
  }[];
}

export type Cause =
  'permission' | 'device' | 'network' | 'server' | 'platform' | 'limit' | 'version' | 'crash';

export interface ErrorGroup {
  key: string;
  code: string;
  scope: string;
  version: string;
  source: 'client' | 'core' | 'services';
  cause: Cause;
  events: number;
  sessions: number;
  people: number;
  sessions_share: number | null;
  people_share: number | null;
  first_at: string;
  last_at: string;
  is_new: boolean;
}

export interface Errors {
  totals: {
    events: number;
    groups: number;
    new_groups: number;
    sessions_affected: number;
    sessions_share: number | null;
    people_affected: number;
    people_share: number | null;
  };
  by_cause: { cause: Cause; events: number; groups: number; sessions: number; people: number }[];
  groups: ErrorGroup[];
  series: { day: string; events: number; sessions: number; people: number }[];
}

export interface Slice {
  key: string;
  events: number;
  sessions: number;
}

export interface ErrorDetail {
  group: {
    key: string;
    code: string;
    scope: string;
    version: string;
    source: 'client' | 'core' | 'services';
    cause: Cause;
    first_at: string;
    last_at: string;
    events_total: number;
    sessions_total: number;
    people_total: number;
  };
  period: {
    events: number;
    sessions: number;
    people: number;
    sessions_share: number | null;
    people_share: number | null;
  };
  series: { day: string; events: number; sessions: number; people: number }[];
  versions: Slice[];
  os: Slice[];
  browsers: Slice[];
  clients: Slice[];
  nodes: Slice[];
  steps: { step: number; events: number }[];
  samples: {
    at: string;
    screen: string | null;
    fatal: boolean;
    detail: string | null;
    step: number | null;
    how: string | null;
    client: string | null;
    version: string | null;
    os: string | null;
    browser: string | null;
  }[];
}

export interface Visits {
  human: number;
  unclear: number;
  bot: number;
  automation: number;
  own: number;
}

export interface Traffic {
  totals: Visits & { visits: number; human_share: number | null };
  by_class: { class: keyof Visits; visits: number; share: number | null }[];
  bots: { bot: string; visits: number }[];
  series: (Visits & { day: string })[];
  by_client: (Visits & { key: string })[];
  by_os: (Visits & { key: string })[];
  by_country: (Visits & { key: string })[];
  by_network: (Visits & { key: string })[];
}

export interface Reports {
  pulse: Pulse;
  audience: Audience;
  acquisition: Acquisition;
  activation: Activation;
  retention: Retention;
  engagement: Engagement;
  integrations: Integrations;
  quality: Quality;
  errors: Errors;
  traffic: Traffic;
}
