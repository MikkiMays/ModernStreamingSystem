"""Карта флота и состояние среды (R240, Р-148…Р-150): все контейнеры всех машин одним ответом, «соседи» отдельно,
люди — на машине своего медиаузла, состояние — по среде и без служебных оповещений."""

import asyncio
import json
import unittest

import httpx

from fleet.fleet_map import CONTAINERS, MACHINE_HISTORY, FleetMap, environment, environment_state, group_of, short_image
from fleet.machines import parse
from fleet.metrics import GROUP, LIVE, Metrics

from .test_api import READ, build, login

MACHINES = parse(
    json.dumps(
        [
            {"id": "a", "role": "dev+admin", "host": "127.0.0.1", "installDir": "/opt/a", "core": {"url": "http://127.0.0.1:8080"}, "nodeId": "fra", "metrics": {"machine": "a"}},
            {"id": "meet", "role": "product-core", "host": "108.165.32.23", "ssh": "root@108.165.32.23", "installDir": "/opt/meet", "core": {"url": "http://127.0.0.1:19112"}, "nodeId": "fra", "title": "meet", "metrics": {"machine": "fra"}},
            {"id": "cordcam", "role": "media-node", "host": "157.22.241.114", "ssh": "root@157.22.241.114", "installDir": "/opt/cord/node", "nodeId": "msk", "metrics": {"machine": "msk"}},
        ]
    ),
    {"a": "password:x", "meet": "key:y"},
)
A, MEET, MSK = MACHINES

LOCAL = {"job": "node", "machine": "a", "kind": "local"}
FRA = {"job": "nodes", "machine": "fra", "kind": "node"}
MSK_NODE = {"job": "nodes", "machine": "msk", "kind": "node"}
SERVICE = "container_label_com_docker_compose_service"


def vector(*rows):
    return {"status": "success", "data": {"resultType": "vector", "result": [{"metric": m, "value": [1, str(v)]} for m, v in rows]}}


def container(base, name, service=None, image="img"):
    labels = {**base, "kind": "containers", "name": name, "image": image}
    if service:
        labels[SERVICE] = service
    return labels


class FakeVictoria:
    def __init__(self, fail=()):
        self.fail = set(fail)
        self.ranges = []
        live = lambda name: LIVE[name][1].format(g=GROUP)  # noqa: E731
        core_fra = {**FRA, "kind": "core"}
        core_a = {**LOCAL, "job": "core"}
        fra_core = container(FRA, "modern-streaming-core-1", "core", "ghcr.io/cord/core:1.4.0@sha256:abc")
        fra_sfu = container(FRA, "modern-streaming-livekit-1", "livekit", "livekit/livekit-server:v1.13.6")
        fra_kiki = container(FRA, "kiki-core", "core", "kiki:latest")
        msk_sfu = container(MSK_NODE, "cord-node-livekit-1", "livekit")
        a_core = container({**LOCAL, "job": "cadvisor"}, "modern-streaming-core-1", "core")
        self.answers = {
            live("up"): vector((LOCAL, 1), (FRA, 1), (MSK_NODE, 0), ({**FRA, "kind": "containers"}, 1)),
            live("cores"): vector((LOCAL, 4), (FRA, 6), (MSK_NODE, 2)),
            live("memTotalBytes"): vector((LOCAL, 8e9), (FRA, 16e9), (MSK_NODE, 4e9)),
            live("memAvailableBytes"): vector((FRA, 8e9)),
            live("cpu"): vector((FRA, 0.25)),
            live("version"): vector(({**core_fra, "version": "1.4.0"}, 1)),
            live("rooms"): vector(({**core_fra, "state": "live"}, 4), ({**core_a, "state": "live"}, 1)),
            live("connected"): vector((core_fra, 11), (core_a, 2)),
            live("nodeRooms"): vector(({**core_fra, "node": "fra"}, 3), ({**core_fra, "node": "msk"}, 1)),
            live("nodeParticipants"): vector(({**core_fra, "node": "fra"}, 9), ({**core_fra, "node": "msk"}, 2)),
            live("sfuMbps"): vector(({**FRA, "kind": "livekit", "direction": "incoming"}, 12), ({**FRA, "kind": "livekit", "direction": "outgoing"}, 80)),
            CONTAINERS["cpu"]: vector((fra_core, 0.6), (fra_sfu, 1.5), (fra_kiki, 0.3), (msk_sfu, 0.2), (a_core, 0.1)),
            CONTAINERS["memBytes"]: vector((fra_core, 1e9), (fra_sfu, 0.5e9), (fra_kiki, 3e9), (msk_sfu, 0.1e9), (a_core, 0.9e9)),
            # У ядра предел 2 ГБ; у SFU cAdvisor отдаёт «без предела» числом больше памяти машины; у чужого — 0.
            CONTAINERS["memLimitBytes"]: vector((fra_core, 2e9), (fra_sfu, 9e18), (fra_kiki, 0)),
            CONTAINERS["startedAt"]: vector((fra_core, 1_793_000_000)),
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        query = request.url.params.get("query", "")
        if request.url.path.endswith("/query_range"):
            self.ranges.append(query)
            row = {**FRA, "kind": "containers"} if "container_" in query else FRA
            return httpx.Response(200, json={"status": "success", "data": {"result": [{"metric": row, "values": [[100, "0.1"], [130, "0.2"]]}]}})
        if query in self.fail:
            return httpx.Response(500, text="boom")
        return httpx.Response(200, json=self.answers.get(query, vector()))


def fleet_map(fake):
    metrics = Metrics("http://vm", "", client=httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)))
    return FleetMap(metrics)


class NamingTest(unittest.TestCase):
    def test_environment_group_and_image(self):
        self.assertEqual([environment(m) for m in MACHINES], ["dev", "product", "product"])
        self.assertEqual(group_of("modern-streaming-core-1"), "cord")
        self.assertEqual(group_of("cord-fleet-cadvisor"), "cord")
        self.assertEqual(group_of("kiki-core"), "neighbour")
        self.assertEqual(group_of("my-cord-thing"), "neighbour")
        self.assertEqual(short_image("ghcr.io/cord/core:1.4.0@sha256:abc"), "core:1.4.0")
        self.assertEqual(short_image("postgres:18.3-alpine"), "postgres:18.3-alpine")


class MapTest(unittest.TestCase):
    def setUp(self):
        self.data = asyncio.run(fleet_map(FakeVictoria()).snapshot(list(MACHINES)))
        self.a, self.meet, self.msk = self.data["machines"]

    def test_every_container_of_every_machine_is_on_the_map(self):
        self.assertIsNone(self.data["error"])
        self.assertEqual([m["id"] for m in self.data["machines"]], ["a", "meet", "cordcam"])
        # Свои — первыми и по памяти; чужой контейнер той же машины — в конце и помечен.
        self.assertEqual(
            [(c["name"], c["group"]) for c in self.meet["containers"]],
            [("modern-streaming-core-1", "cord"), ("modern-streaming-livekit-1", "cord"), ("kiki-core", "neighbour")],
        )
        self.assertEqual(self.meet["neighbours"], {"count": 1, "cpu": 0.3, "memBytes": 3e9})
        self.assertEqual(self.a["neighbours"]["count"], 0)
        self.assertEqual([c["name"] for c in self.msk["containers"]], ["cord-node-livekit-1"])

    def test_shares_are_of_the_limit_or_of_the_machine(self):
        core, sfu, kiki = self.meet["containers"]
        self.assertEqual(core["service"], "core")
        self.assertEqual(core["image"], "core:1.4.0")
        self.assertAlmostEqual(core["cpuShare"], 0.1)  # 0,6 ядра из шести
        self.assertEqual(core["memLimitBytes"], 2e9)
        self.assertEqual(core["memShare"], 0.5)
        self.assertEqual(core["startedAt"], 1_793_000_000)
        # «Без предела» у cAdvisor — число больше памяти машины или ноль: доля считается от машины.
        self.assertIsNone(sfu["memLimitBytes"])
        self.assertEqual(sfu["memShare"], 0.5e9 / 16e9)
        self.assertIsNone(kiki["memLimitBytes"])

    def test_network_only_where_the_service_counts_it(self):
        core, sfu, _ = self.meet["containers"]
        # Контейнеры на сети хоста: счётчики cAdvisor у всех общие — у ядра сети нет, у SFU она из его метрик.
        self.assertIsNone(core["netOutMbps"])
        self.assertEqual((sfu["netInMbps"], sfu["netOutMbps"]), (12, 80))

    def test_people_sit_on_the_machine_of_their_media_node(self):
        self.assertEqual(self.meet["meetings"], {"live": 3, "people": 9})
        self.assertEqual(self.msk["meetings"], {"live": 1, "people": 2})
        # Стенд — своя среда и своё ядро без реестра узлов: его встречи — на нём, а не в продукте.
        self.assertEqual(self.a["meetings"], {"live": 1, "people": 2})
        self.assertEqual(self.meet["environment"], "product")
        self.assertEqual(self.a["environment"], "dev")

    def test_machine_header(self):
        self.assertEqual(self.meet["version"], "1.4.0")
        self.assertEqual(self.meet["hardware"]["cores"], 6)
        self.assertEqual(self.meet["load"]["cpu"], 0.25)
        self.assertEqual(self.meet["load"]["memUsed"], 0.5)
        self.assertIs(self.meet["online"], True)
        self.assertIs(self.msk["online"], False)

    def test_failed_container_series_do_not_break_the_map(self):
        data = asyncio.run(fleet_map(FakeVictoria(fail=[CONTAINERS["memBytes"]])).snapshot(list(MACHINES)))
        self.assertIn("memBytes", data["error"])
        self.assertEqual(data["machines"][1]["containers"][0]["cpu"] is not None, True)

    def test_without_monitoring_the_map_lists_machines(self):
        data = asyncio.run(FleetMap(Metrics("", "")).snapshot(list(MACHINES)))
        self.assertIn("monitoring", data["error"])
        self.assertEqual([m["containers"] for m in data["machines"]], [[], [], []])


class HistoryTest(unittest.TestCase):
    def test_machine_and_container_series(self):
        fake = FakeVictoria()
        fmap = fleet_map(fake)
        machine = asyncio.run(fmap.history(MEET, None, 30))
        self.assertEqual(sorted(machine["series"]), sorted(MACHINE_HISTORY))
        self.assertEqual(machine["series"]["cpu"], [[100, 0.1], [130, 0.2]])
        one = asyncio.run(fmap.history(MEET, "modern-streaming-core-1", 30))
        self.assertEqual(sorted(one["series"]), ["cpu", "memBytes"])
        self.assertEqual(one["series"]["memBytes"], [[100, 0.1], [130, 0.2]])
        self.assertTrue(all('name="modern-streaming-core-1"' in q for q in fake.ranges[-2:]))

    def test_container_name_cannot_carry_a_query(self):
        fmap = fleet_map(FakeVictoria())
        for bad in ('x"} or up{a="', "", "a b", "x{y}", "-x"):
            with self.assertRaises(ValueError):
                asyncio.run(fmap.history(MEET, bad, 30))


def live_of(node=None):
    return {"machines": {m.id: {"sources": {"node": (node or {}).get(m.id, True)}} for m in MACHINES}, "error": None}


def alert(name, severity, node=None, state="firing", at="2026-11-12T08:00:00Z"):
    return {"name": name, "severity": severity, "node": node, "state": state, "activeAt": at, "summary": name}


class StateTest(unittest.TestCase):
    def state(self, alerts=(), nows=None, node=None):
        return environment_state(list(MACHINES), live_of(node), {"alerts": list(alerts), "error": None}, nows or {})

    def test_quiet_fleet_is_ok_and_watchdog_is_not_a_problem(self):
        got = self.state([alert("Watchdog", "none"), alert("Сведение", "info"), alert("Погасло", "page", "fra", state="pending")])
        self.assertEqual(got["product"]["level"], "ok")
        self.assertIsNone(got["product"]["reason"])
        self.assertEqual(got["dev"]["level"], "ok")
        self.assertEqual((got["product"]["machines"], got["product"]["online"]), (2, 2))

    def test_alert_belongs_to_the_environment_of_its_machine(self):
        got = self.state([alert("HostStalled", "warn", "fra"), alert("SiteUnreachable", "page")])
        # Метка `fra` — машина продукта; оповещение без машины — стенд, где стоит мониторинг.
        self.assertEqual(got["product"]["level"], "warn")
        self.assertEqual(got["product"]["reason"], "HostStalled")
        self.assertEqual(got["dev"]["level"], "bad")
        self.assertEqual(got["dev"]["problems"][0]["kind"], "alert")

    def test_worst_and_earliest_problem_is_the_reason(self):
        got = self.state(
            [alert("Поздний сбой", "page", "msk", at="2026-11-12T09:00:00Z"), alert("Ранний сбой", "page", "fra", at="2026-11-12T07:00:00Z"), alert("Внимание", "warn", "fra", at="2026-11-12T06:00:00Z")]
        )
        self.assertEqual(got["product"]["reason"], "Ранний сбой")
        self.assertEqual(got["product"]["since"], "2026-11-12T07:00:00Z")
        self.assertEqual([p["level"] for p in got["product"]["problems"]], ["bad", "bad", "warn"])

    def test_silent_core_is_bad_and_silent_metrics_are_a_warning(self):
        got = self.state(nows={"meet": {"data": None, "error": {"code": "CORE_UNREACHABLE"}}, "a": {"data": {}, "error": None}}, node={"cordcam": False})
        self.assertEqual(got["product"]["level"], "bad")
        self.assertIn("meet", got["product"]["reason"])
        self.assertEqual([p["kind"] for p in got["product"]["problems"]], ["core", "metrics"])
        self.assertEqual(got["product"]["online"], 1)
        self.assertEqual(got["dev"]["level"], "ok")


class RoutesTest(unittest.TestCase):
    def test_state_and_map_need_login_and_answer(self):
        client, _, _ = build()
        for path in ("/api/fleet/state", "/api/fleet/map", "/api/fleet/map/history?machine=a"):
            self.assertEqual(client.get(path, headers=READ).status_code, 401)
        login(client)
        state = client.get("/api/fleet/state", headers=READ).json()
        self.assertEqual(sorted(state["environments"]), ["dev", "product"])
        self.assertEqual(state["environments"]["product"]["level"], "ok")
        data = client.get("/api/fleet/map", headers=READ).json()
        self.assertEqual([m["id"] for m in data["machines"]], ["a", "meet"])
        self.assertEqual(client.get("/api/fleet/map/history?machine=a", headers=READ).json()["step"], None)
        self.assertEqual(client.get("/api/fleet/map/history?machine=zz", headers=READ).status_code, 404)
        bad = client.get('/api/fleet/map/history?machine=a&container=x"}', headers=READ)
        self.assertEqual((bad.status_code, bad.json()["code"]), (400, "OPERATION_INVALID"))
