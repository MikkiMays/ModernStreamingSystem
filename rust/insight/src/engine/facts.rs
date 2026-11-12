//! Факты ядра и служб: входы, присутствие, встречи, качество, интеграции (`contracts/insight.md` §2).
//!
//! Факт принимается один раз: его `id` запоминается в той же транзакции, что и его следы. Секунды на связи
//! считаются от прошлой отметки (тик `presence` или край `media_up`/`media_down`), не больше 90 с за раз, и
//! делятся по дням пояса аналитики. Сводки качества складываются в памяти в строку встречи и строку
//! «человек × день» — строки на сводку нет.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;

use super::store::{ErrorDims, EventRow};
use super::{Engine, ErrorNote, Evidence, Who, note_error};
use crate::classify::{Class, reason};
use crate::days::{from_ms, local_day, split_days};
use crate::event::KINDS;
use crate::fact::{Fact, Facts};

/// Больше за один раз на связи не засчитывается: пропавший тик не превращается в час разговора.
const CREDIT_CAP_SECONDS: i64 = 90;
/// Зритель интеграции считается смотрящим, пока от него приходят события.
const VIEWER_SECONDS: i64 = 90;
/// Встреча или запуск без единого факта столько часов считается оконченным: ядро о нём уже не скажет.
const STALE_HOURS: i64 = 6;

/// Участник на связи.
struct Member {
    profile: Option<String>,
    who: Option<Who>,
    /// До какого момента секунды уже засчитаны.
    since: DateTime<Utc>,
    /// Что засчитано за это присутствие, по дням.
    credited: Vec<(NaiveDate, i64)>,
    together: i64,
}

/// Прибавки к строке встречи с прошлой записи.
#[derive(Default)]
struct MeetingDelta {
    joins: i64,
    person_s: i64,
    together_s: i64,
    mic_s: i64,
    cam_s: i64,
    screen_s: i64,
    bytes_up: i64,
    bytes_down: i64,
    summaries: i64,
    relay: i64,
    loss_sum: f64,
    rtt_sum: f64,
    freezes: i64,
    reconnects: i64,
    moves: i64,
}

/// Встреча: от открытия комнаты до закрытия.
pub struct Meeting {
    id: Option<i64>,
    room: String,
    node: String,
    opened_at: DateTime<Utc>,
    day: NaiveDate,
    /// Ядро сказало `meeting_open`; иначе встреча заведена по первому факту о ней.
    announced: bool,
    creator: Option<i64>,
    closed: Option<(DateTime<Utc>, String)>,
    members: HashMap<String, Member>,
    peak: i64,
    delta: MeetingDelta,
    pub(super) dirty: bool,
    last: DateTime<Utc>,
}

impl Meeting {
    fn open(room: &str, at: DateTime<Utc>, day: NaiveDate) -> Self {
        Meeting {
            id: None,
            room: room.to_owned(),
            node: String::new(),
            opened_at: at,
            day,
            announced: false,
            creator: None,
            closed: None,
            members: HashMap::new(),
            peak: 0,
            delta: MeetingDelta::default(),
            dirty: true,
            last: at,
        }
    }

    pub(super) fn has_device(&self, device: &str) -> bool {
        self.members.values().any(|m| m.who.as_ref().is_some_and(|who| who.device == device))
    }
}

/// Запуск интеграции.
pub struct Run {
    run: String,
    room: String,
    kind: String,
    variant: String,
    opener: Option<i64>,
    opened_at: DateTime<Utc>,
    day: NaiveDate,
    closed: Option<(DateTime<Utc>, String)>,
    peak: i64,
    viewers: HashMap<i64, DateTime<Utc>>,
    /// Человеко-секунды, байты, секунды потока, ошибки, застои, мс застоев — с прошлой записи.
    delta: [i64; 6],
    pub(super) dirty: bool,
    last: DateTime<Utc>,
}

impl Run {
    /// Человек смотрел: секунды, застои и мс застоев с его прошлой отправки.
    pub(super) fn viewed(&mut self, person: i64, at: DateTime<Utc>, view: [i64; 3]) {
        self.delta[0] += view[0];
        self.delta[4] += view[1];
        self.delta[5] += view[2];
        self.viewers.insert(person, at);
        self.viewers.retain(|_, seen| at - *seen < Duration::seconds(VIEWER_SECONDS));
        self.peak = self.peak.max(self.viewers.len() as i64);
        self.last = self.last.max(at);
        self.dirty = true;
    }
}

impl Engine {
    /// Открытые встречи и запуски из базы — после перезапуска службы факты о них продолжают те же строки.
    pub async fn load(&mut self, now: DateTime<Utc>) -> Result<(), sqlx::Error> {
        self.now = self.now.max(now);
        let since = now - Duration::days(2);
        let meetings: Vec<(i64, String, String, DateTime<Utc>, NaiveDate, i32)> = sqlx::query_as(
            "SELECT id, room, node, opened_at, day, peak FROM an_meetings WHERE closed_at IS NULL AND opened_at >= $1",
        )
        .bind(since)
        .fetch_all(&self.pool)
        .await?;
        for (id, room, node, opened_at, day, peak) in meetings {
            let meeting = Meeting {
                id: Some(id),
                node,
                announced: true,
                peak: i64::from(peak),
                dirty: false,
                last: now,
                ..Meeting::open(&room, opened_at, day)
            };
            self.meetings.insert(room, meeting);
        }
        let runs: Vec<(String, String, String, String, DateTime<Utc>, NaiveDate, i32)> = sqlx::query_as(
            "SELECT run, room, kind, variant, opened_at, day, peak FROM an_integration_runs \
             WHERE closed_at IS NULL AND opened_at >= $1",
        )
        .bind(since)
        .fetch_all(&self.pool)
        .await?;
        for (run, room, kind, variant, opened_at, day, peak) in runs {
            self.open_runs.insert((room.clone(), kind.clone()), run.clone());
            let state = Run {
                run: run.clone(),
                room,
                kind,
                variant,
                opener: None,
                opened_at,
                day,
                closed: None,
                peak: i64::from(peak),
                viewers: HashMap::new(),
                delta: [0; 6],
                dirty: false,
                last: now,
            };
            self.runs.insert(run, state);
        }
        Ok(())
    }

    /// Пачка фактов. Уже принятые `id` пропускаются: повтор ничего не удваивает.
    pub(super) async fn facts(&mut self, batch: Facts, now: DateTime<Utc>) -> Result<(), sqlx::Error> {
        self.now = self.now.max(now);
        let ids: Vec<String> = batch.facts.iter().map(|f| f.id.clone()).collect();
        let stored: Vec<String> =
            sqlx::query_scalar("SELECT id FROM an_fact_ids WHERE id = ANY($1)").bind(&ids).fetch_all(&self.pool).await?;
        let stored: HashSet<String> = stored.into_iter().collect();
        let source = if batch.source == "services" { "services" } else { "core" };
        self.metrics.add("insight_facts_dropped_total", &[("reason", "unknown")], batch.dropped as u64);
        for fact in batch.facts {
            if stored.contains(&fact.id) || self.fact_seen.contains(&fact.id) {
                self.metrics.inc("insight_facts_dropped_total", &[("reason", "duplicate")]);
                continue;
            }
            self.fact(&fact, source).await?;
            let at = from_ms(fact.at);
            self.metrics.inc("insight_facts_accepted_total", &[("type", fact.name)]);
            self.metrics.set("insight_facts_lag_seconds", &[], (now - at).num_milliseconds() as f64 / 1000.0);
            self.fact_seen.insert(fact.id.clone());
            self.pending.fact_ids.push((fact.id, at));
        }
        Ok(())
    }

    async fn fact(&mut self, f: &Fact, source: &'static str) -> Result<(), sqlx::Error> {
        let at = from_ms(f.at);
        let day = local_day(at, self.zone);
        let room = f.text("room").map(|room| self.keys.room(&room));
        let profile = f.text("profile");
        // Всё, что читает базу, — до изменений в памяти: отказ базы не оставляет факт сделанным наполовину.
        let mut who = match &profile {
            Some(profile) => self.who(profile).await?,
            None => None,
        };
        match f.name {
            "join" => {
                self.pending.count(day, "join", &f.word("how"), &f.word("node"), 1);
                if let Some(room) = &room {
                    let meeting = self.meeting(room, at, day);
                    meeting.delta.joins += 1;
                    if meeting.node.is_empty() {
                        meeting.node = f.word("node");
                    }
                }
                if let (Some(who), Some(profile)) = (&who, &profile) {
                    self.pending.day(who.person, day).add("joins", 1);
                    let props = json!({"how": f.word("how"), "node": f.word("node"), "client": f.word("client")});
                    self.fact_event(who.person, profile, "join", at, day, room, props);
                    self.advance(profile, 5);
                }
            }
            "join_fail" => {
                let (code, how) = (f.word("code"), f.word("how"));
                self.pending.count(day, "join_fail", &code, &how, 1);
                self.server_error(&code, "join", source, at, day, who.as_ref().map(|w| w.person), 1);
                if let (Some(who), Some(profile)) = (&who, &profile) {
                    let props = json!({"code": code, "how": how, "key": crate::errors::key(&code, "join", source)});
                    self.fact_event(who.person, profile, "join_fail", at, day, None, props);
                }
            }
            "media_up" => {
                if let Some(profile) = &profile {
                    who = self.confirm(profile, who, at, day).await?;
                }
                if let (Some(room), Some(member)) = (&room, f.text("member")) {
                    // Всем, кто уже на связи, — до этого момента и по прежнему числу людей: «не один»
                    // начинается с приходом второго, а не с ближайшего тика.
                    self.credit_all(room, at);
                    let meeting = self.meeting(room, at, day);
                    if meeting.node.is_empty() {
                        meeting.node = f.word("node");
                    }
                    let fresh = Member { profile, who, since: at, credited: Vec::new(), together: 0 };
                    let known = meeting.members.entry(member).or_insert(fresh);
                    known.since = known.since.max(at);
                    meeting.peak = meeting.peak.max(meeting.members.len() as i64);
                }
            }
            "media_down" => {
                self.pending.count(day, "media_down", &f.word("reason"), "", 1);
                if let (Some(room), Some(member)) = (&room, f.text("member")) {
                    self.credit_all(room, at);
                    self.depart(room, &member, at, Some(f.word("reason")));
                }
            }
            "presence" => {
                let Some(room) = &room else { return Ok(()) };
                let present = f.members();
                // Новые в тике участники: их люди ищутся в базе до каких-либо изменений.
                let mut arrivals = Vec::new();
                for (member, profile) in &present {
                    let known = self.meetings.get(room).is_some_and(|m| m.members.contains_key(member));
                    if !known {
                        let who = match profile {
                            Some(profile) => self.who(profile).await?,
                            None => None,
                        };
                        arrivals.push((member.clone(), profile.clone(), who));
                    }
                }
                let names: HashSet<&String> = present.iter().map(|(member, _)| member).collect();
                let meeting = self.meeting(room, at, day);
                if meeting.node.is_empty() {
                    meeting.node = f.word("node");
                }
                let (stay, gone): (Vec<String>, Vec<String>) =
                    meeting.members.keys().cloned().partition(|member| names.contains(member));
                for member in &stay {
                    self.credit(room, member, at);
                }
                // Кого в тике нет, тот ушёл без `media_down`: больше ему не засчитывается.
                for member in &gone {
                    self.depart(room, member, at, None);
                }
                let meeting = self.meeting(room, at, day);
                for (member, profile, who) in arrivals {
                    meeting.members.insert(member, Member { profile, who, since: at, credited: Vec::new(), together: 0 });
                }
                meeting.peak = meeting.peak.max(meeting.members.len() as i64);
            }
            "meeting_open" => {
                let Some(room) = &room else { return Ok(()) };
                // Прежняя встреча этой комнаты не закрыта, а ядро открывает новую: прежняя кончилась.
                if self.meetings.get(room).is_some_and(|m| m.announced) {
                    self.close_meeting(room, at, "unknown", 0);
                }
                let meeting = self.meeting(room, at, day);
                meeting.announced = true;
                meeting.opened_at = meeting.opened_at.min(at);
                meeting.node = f.word("node");
                meeting.creator = who.map(|w| w.person);
            }
            "meeting_close" => {
                if let Some(room) = &room {
                    self.close_meeting(room, at, &f.word("reason"), f.int("peak"));
                }
            }
            "quality" => {
                let seconds = [f.int("mic_s"), f.int("cam_s"), f.int("screen_s")];
                if let Some(meeting) = room.as_ref().and_then(|room| self.meetings.get_mut(room)) {
                    let d = &mut meeting.delta;
                    d.mic_s += seconds[0];
                    d.cam_s += seconds[1];
                    d.screen_s += seconds[2];
                    d.bytes_up += f.int("bytes_up");
                    d.bytes_down += f.int("bytes_down");
                    d.summaries += 1;
                    d.relay += i64::from(f.flag("relay"));
                    d.loss_sum += f.num("loss");
                    d.rtt_sum += f.num("rtt");
                    d.freezes += f.int("freezes");
                    d.reconnects += f.int("reconnects");
                    meeting.dirty = true;
                    meeting.last = meeting.last.max(at);
                }
                if let Some(who) = &who {
                    let delta = self.pending.day(who.person, day);
                    delta.add("mic_s", seconds[0]);
                    delta.add("cam_s", seconds[1]);
                    delta.add("screen_s", seconds[2]);
                }
            }
            "integration_open" => {
                let (Some(room), Some(run)) = (&room, f.text("run")) else { return Ok(()) };
                let kind = f.word("kind");
                if !KINDS.contains(&kind.as_str()) {
                    return Ok(());
                }
                let variant = f.word("variant");
                self.pending.count(day, "integration_open", &kind, &variant, 1);
                self.open_runs.insert((room.clone(), kind.clone()), run.clone());
                let state = Run {
                    run: run.clone(),
                    room: room.clone(),
                    kind,
                    variant,
                    opener: who.map(|w| w.person),
                    opened_at: at,
                    day,
                    closed: None,
                    peak: 0,
                    viewers: HashMap::new(),
                    delta: [0; 6],
                    dirty: true,
                    last: at,
                };
                self.runs.insert(run, state);
            }
            "integration_close" => {
                if let Some(run) = f.text("run").and_then(|id| self.runs.get_mut(&id)) {
                    run.closed = Some((at, f.word("reason")));
                    run.dirty = true;
                    let slot = (run.room.clone(), run.kind.clone());
                    if self.open_runs.get(&slot) == Some(&run.run) {
                        self.open_runs.remove(&slot);
                    }
                }
            }
            "integration_error" => {
                let (kind, variant, code) = (f.word("kind"), f.word("variant"), f.word("code"));
                self.pending.count(day, "integration_error", &format!("{kind}/{variant}"), &code, 1);
                self.server_error(&code, &kind, source, at, day, None, 1);
                let id = f.text("run").or_else(|| room.as_ref().and_then(|room| self.open_runs.get(&(room.clone(), kind)).cloned()));
                if let Some(run) = id.and_then(|id| self.runs.get_mut(&id)) {
                    run.delta[3] += 1;
                    run.dirty = true;
                    run.last = run.last.max(at);
                }
            }
            "usage" => {
                let id = room.as_ref().and_then(|room| self.open_runs.get(&(room.clone(), f.word("kind"))));
                match id.cloned().and_then(|id| self.runs.get_mut(&id)) {
                    Some(run) => {
                        run.delta[1] += f.int("bytes");
                        run.delta[2] += f.int("seconds");
                        run.dirty = true;
                        run.last = run.last.max(at);
                    }
                    None => self.metrics.inc("insight_facts_dropped_total", &[("reason", "no_run")]),
                }
            }
            "node_move" => {
                self.pending.count(day, "node_move", &f.word("reason"), &f.word("to"), 1);
                if let Some(meeting) = room.as_ref().and_then(|room| self.meetings.get_mut(room)) {
                    meeting.delta.moves += 1;
                    meeting.node = f.word("to");
                    meeting.dirty = true;
                }
            }
            "refusal" => {
                let count = f.int("count").max(1);
                self.pending.count(day, "refusal", &f.word("code"), "", count);
                self.server_error(&f.word("code"), "guard", source, at, day, None, count);
            }
            _ => {}
        }
        Ok(())
    }

    /// Ошибка, которую вернул сервер: своя группа с именем отправителя на месте версии.
    #[allow(clippy::too_many_arguments)]
    fn server_error(
        &mut self,
        code: &str,
        scope: &str,
        source: &'static str,
        at: DateTime<Utc>,
        day: NaiveDate,
        person: Option<i64>,
        count: i64,
    ) {
        let note = ErrorNote {
            code,
            scope,
            version: source,
            source,
            at,
            day,
            dims: ErrorDims { client: source.to_owned(), ..ErrorDims::default() },
            first_in_session: false,
            person,
            sample: json!({"at": at, "client": source}),
            count,
        };
        note_error(&mut self.pending, note);
    }

    /// Строка события человека из факта ядра; сессия — самая свежая живая с этим профилем.
    #[allow(clippy::too_many_arguments)]
    fn fact_event(
        &mut self,
        person: i64,
        profile: &str,
        name: &'static str,
        at: DateTime<Utc>,
        day: NaiveDate,
        room: Option<String>,
        props: Value,
    ) {
        let sid = self.live_of(profile).cloned();
        self.pending.event(EventRow { at, day, sid, person: Some(person), name, room, props });
    }

    /// Профиль соединился с медиаузлом: человек подтверждён. Сессия «неясно» с этим профилем становится
    /// человеком; сессии ещё нет — профиль запоминается, пока она не придёт.
    async fn confirm(
        &mut self,
        profile: &str,
        who: Option<Who>,
        at: DateTime<Utc>,
        day: NaiveDate,
    ) -> Result<Option<Who>, sqlx::Error> {
        let who = match who {
            Some(who) => who,
            None => {
                let waiting = self.by_profile.get(profile).and_then(|sids| {
                    sids.iter().rev().find(|sid| {
                        self.sessions.get(*sid).is_some_and(|live| live.class == Class::Unclear && live.who.is_none())
                    })
                });
                let Some(sid) = waiting.cloned() else {
                    self.confirmed.insert(profile.to_owned(), at);
                    return Ok(None);
                };
                if let Some(live) = self.sessions.get_mut(&sid) {
                    live.want = Some(Evidence::Media);
                }
                self.promote(&sid, at).await?;
                match self.who(profile).await? {
                    Some(who) => who,
                    None => return Ok(None),
                }
            }
        };
        self.pending.day(who.person, day).confirmed = true;
        let first = self.pending.called.entry(who.person).or_insert(day);
        *first = (*first).min(day);
        for sid in self.by_profile.get(profile).into_iter().flatten() {
            let Some(live) = self.sessions.get_mut(sid).filter(|live| live.who.is_some()) else { continue };
            if live.class == Class::Engaged {
                live.class = Class::Confirmed;
                live.reason = reason::MEDIA;
                self.metrics.inc("insight_sessions_total", &[("class", "confirmed"), ("reason", reason::MEDIA)]);
            }
            live.step = live.step.max(6);
            live.dirty = true;
            self.guard.call(&live.subnet, at);
        }
        Ok(Some(who))
    }

    /// Встреча комнаты; нет в памяти — заводится по первому факту о ней.
    fn meeting(&mut self, room: &str, at: DateTime<Utc>, day: NaiveDate) -> &mut Meeting {
        let meeting = self.meetings.entry(room.to_owned()).or_insert_with(|| Meeting::open(room, at, day));
        meeting.dirty = true;
        meeting.last = meeting.last.max(at);
        meeting
    }

    /// Засчитать всем на связи секунды до `to`.
    fn credit_all(&mut self, room: &str, to: DateTime<Utc>) {
        let members: Vec<String> = self.meetings.get(room).map(|m| m.members.keys().cloned().collect()).unwrap_or_default();
        for member in &members {
            self.credit(room, member, to);
        }
    }

    /// Засчитать участнику секунды на связи от прошлой отметки до `to`.
    fn credit(&mut self, room: &str, member: &str, to: DateTime<Utc>) {
        let zone = self.zone;
        let Some(meeting) = self.meetings.get_mut(room) else { return };
        // Не один — значит, с собеседником: по этому человек становится собеседником дня.
        let together = meeting.members.len() >= 2;
        let Some(state) = meeting.members.get_mut(member) else { return };
        let from = state.since.max(to - Duration::seconds(CREDIT_CAP_SECONDS));
        state.since = state.since.max(to);
        let was_together = state.together;
        let mut talked = None;
        for (day, seconds) in split_days(from, to, zone) {
            meeting.delta.person_s += seconds;
            match state.credited.iter_mut().find(|(d, _)| *d == day) {
                Some((_, sum)) => *sum += seconds,
                None => state.credited.push((day, seconds)),
            }
            if together {
                meeting.delta.together_s += seconds;
                state.together += seconds;
            }
            if let Some(who) = &state.who {
                let delta = self.pending.day(who.person, day);
                delta.add("talk_s", seconds);
                if together {
                    delta.add("together_s", seconds);
                }
            }
        }
        if state.together >= 60 {
            talked = state.profile.clone();
            // Минута не в одиночку набралась сейчас: с этого момента человек — собеседник.
            if let Some(who) = state.who.as_ref().filter(|_| was_together < 60) {
                let since = self.pending.peers.entry(who.person).or_insert(to);
                *since = (*since).min(to);
            }
        }
        meeting.dirty = true;
        meeting.last = meeting.last.max(to);
        if let Some(profile) = talked {
            self.advance(&profile, 7);
        }
    }

    /// Участник ушёл: событие `presence` с секундами по дням и, если ядро назвало причину, `leave`.
    fn depart(&mut self, room: &str, member: &str, at: DateTime<Utc>, why: Option<String>) {
        let Some(state) = self.meetings.get_mut(room).and_then(|m| m.members.remove(member)) else { return };
        let Some(who) = state.who else { return };
        let sid = state.profile.as_ref().and_then(|profile| self.live_of(profile).cloned());
        for (day, seconds) in state.credited {
            let props = json!({"seconds": seconds});
            let row = EventRow { at, day, sid: sid.clone(), person: Some(who.person), name: "presence", room: Some(room.to_owned()), props };
            self.pending.event(row);
        }
        if let Some(why) = why {
            let day = local_day(at, self.zone);
            let props = json!({"reason": why, "by": "core"});
            let row = EventRow { at, day, sid, person: Some(who.person), name: "leave", room: Some(room.to_owned()), props };
            self.pending.event(row);
        }
    }

    /// Встреча кончилась: всем на связи засчитывается до этого момента, строка закрывается.
    fn close_meeting(&mut self, room: &str, at: DateTime<Utc>, why: &str, peak: i64) {
        self.credit_all(room, at);
        let members: Vec<String> = self.meetings.get(room).map(|m| m.members.keys().cloned().collect()).unwrap_or_default();
        for member in &members {
            self.depart(room, member, at, None);
        }
        if let Some(mut meeting) = self.meetings.remove(room) {
            meeting.closed = Some((at.max(meeting.opened_at), why.to_owned()));
            meeting.peak = meeting.peak.max(peak);
            meeting.dirty = true;
            self.finished.push(meeting);
        }
    }

    /// Закрыть встречи и запуски, о которых давно нет фактов: `meeting_close` потерялся.
    pub(super) fn sweep_meetings(&mut self, now: DateTime<Utc>) {
        let stale = Duration::hours(STALE_HOURS);
        let rooms: Vec<(String, DateTime<Utc>)> =
            self.meetings.iter().filter(|(_, m)| now - m.last >= stale).map(|(room, m)| (room.clone(), m.last)).collect();
        for (room, last) in rooms {
            self.close_meeting(&room, last, "unknown", 0);
        }
        for run in self.runs.values_mut().filter(|run| run.closed.is_none() && now - run.last >= stale) {
            run.closed = Some((run.last, "unknown".to_owned()));
            run.dirty = true;
            self.open_runs.remove(&(run.room.clone(), run.kind.clone()));
        }
    }

    /// Записать встречи: новые — вставкой, известные — прибавкой. Возвращает номера новых строк идущих встреч.
    pub(super) async fn write_meetings(&self, conn: &mut PgConnection) -> Result<Vec<(String, i64)>, sqlx::Error> {
        for meeting in self.finished.iter().filter(|m| m.dirty) {
            write_meeting(conn, meeting).await?;
        }
        let mut ids = Vec::new();
        for meeting in self.meetings.values().filter(|m| m.dirty) {
            let id = write_meeting(conn, meeting).await?;
            if let (None, Some(id)) = (meeting.id, id) {
                ids.push((meeting.room.clone(), id));
            }
        }
        Ok(ids)
    }

    /// Записать запуски интеграций.
    pub(super) async fn write_runs(&self, conn: &mut PgConnection) -> Result<(), sqlx::Error> {
        for run in self.runs.values().filter(|run| run.dirty) {
            let (closed_at, why) = match &run.closed {
                Some((at, why)) => (Some(*at), why.as_str()),
                None => (None, ""),
            };
            sqlx::query(
                "INSERT INTO an_integration_runs AS r (run, room, kind, variant, opener, opened_at, day, closed_at, \
                   peak, person_s, bytes, stream_s, errors, stalls, stall_ms, close_reason) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) \
                 ON CONFLICT (run) DO UPDATE SET closed_at = COALESCE(EXCLUDED.closed_at, r.closed_at), \
                   opener = COALESCE(r.opener, EXCLUDED.opener), peak = GREATEST(r.peak, EXCLUDED.peak), \
                   person_s = r.person_s + EXCLUDED.person_s, bytes = r.bytes + EXCLUDED.bytes, \
                   stream_s = r.stream_s + EXCLUDED.stream_s, errors = r.errors + EXCLUDED.errors, \
                   stalls = r.stalls + EXCLUDED.stalls, stall_ms = r.stall_ms + EXCLUDED.stall_ms, \
                   close_reason = CASE WHEN EXCLUDED.close_reason = '' THEN r.close_reason ELSE EXCLUDED.close_reason END",
            )
            .bind(&run.run)
            .bind(&run.room)
            .bind(&run.kind)
            .bind(&run.variant)
            .bind(run.opener)
            .bind(run.opened_at)
            .bind(run.day)
            .bind(closed_at)
            .bind(run.peak as i32)
            .bind(run.delta[0])
            .bind(run.delta[1])
            .bind(run.delta[2])
            .bind(run.delta[3] as i32)
            .bind(run.delta[4] as i32)
            .bind(run.delta[5])
            .bind(why)
            .execute(&mut *conn)
            .await?;
        }
        Ok(())
    }

    /// Запись удалась: новым встречам — их номера, прибавки обнулить, оконченное забыть.
    pub(super) fn settle_meetings(&mut self, ids: Vec<(String, i64)>) {
        for (room, id) in ids {
            if let Some(meeting) = self.meetings.get_mut(&room).filter(|m| m.id.is_none()) {
                meeting.id = Some(id);
            }
        }
        self.discard_meetings();
    }

    /// Обнулить прибавки встреч и запусков и забыть оконченные.
    pub(super) fn discard_meetings(&mut self) {
        self.finished.clear();
        for meeting in self.meetings.values_mut() {
            meeting.delta = MeetingDelta::default();
            meeting.dirty = false;
        }
        self.runs.retain(|_, run| run.closed.is_none());
        for run in self.runs.values_mut() {
            run.delta = [0; 6];
            run.dirty = false;
        }
    }
}

/// Строка встречи: вставка новой или прибавка к известной. Возвращает номер строки.
async fn write_meeting(conn: &mut PgConnection, meeting: &Meeting) -> Result<Option<i64>, sqlx::Error> {
    let d = &meeting.delta;
    let (closed_at, why) = match &meeting.closed {
        Some((at, why)) => (Some(*at), why.as_str()),
        None => (None, ""),
    };
    let query = match meeting.id {
        None => sqlx::query_scalar(
            "INSERT INTO an_meetings (room, node, opened_at, day, closed_at, creator, peak, joins, person_s, \
               together_s, mic_s, cam_s, screen_s, bytes_up, bytes_down, summaries, relay, loss_sum, rtt_sum, \
               freezes, reconnects, moves, close_reason) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, \
               $20, $21, $22, $23) RETURNING id",
        )
        .bind(&meeting.room)
        .bind(&meeting.node)
        .bind(meeting.opened_at)
        .bind(meeting.day),
        Some(id) => sqlx::query_scalar(
            "UPDATE an_meetings SET node = $2, closed_at = COALESCE($3, closed_at), \
               creator = COALESCE($4, creator), peak = GREATEST(peak, $5), joins = joins + $6, \
               person_s = person_s + $7, together_s = together_s + $8, mic_s = mic_s + $9, cam_s = cam_s + $10, \
               screen_s = screen_s + $11, bytes_up = bytes_up + $12, bytes_down = bytes_down + $13, \
               summaries = summaries + $14, relay = relay + $15, loss_sum = loss_sum + $16, \
               rtt_sum = rtt_sum + $17, freezes = freezes + $18, reconnects = reconnects + $19, \
               moves = moves + $20, close_reason = CASE WHEN $21 = '' THEN close_reason ELSE $21 END \
             WHERE id = $1 RETURNING id",
        )
        .bind(id)
        .bind(&meeting.node),
    };
    query
        .bind(closed_at)
        .bind(meeting.creator)
        .bind(meeting.peak as i32)
        .bind(d.joins as i32)
        .bind(d.person_s)
        .bind(d.together_s)
        .bind(d.mic_s)
        .bind(d.cam_s)
        .bind(d.screen_s)
        .bind(d.bytes_up)
        .bind(d.bytes_down)
        .bind(d.summaries as i32)
        .bind(d.relay as i32)
        .bind(d.loss_sum)
        .bind(d.rtt_sum)
        .bind(d.freezes as i32)
        .bind(d.reconnects as i32)
        .bind(d.moves as i32)
        .bind(why)
        .fetch_optional(conn)
        .await
}
