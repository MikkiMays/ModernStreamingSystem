"""«Флот — live» (R209, Р-125): групповые запросы к VictoriaMetrics раскладываются по машинам и видам источников
по меткам целей — у туннелей (`job="nodes"`, `machine`, `kind`), у этой машины до R212 (только `job`) и после
(`machine="a"`, `kind="local"`)."""

import asyncio
import json
import unittest

import httpx

from fleet.machines import parse
from fleet.metrics import GROUP, HISTORY, LIVE, Metrics, machine_label, source_of

from .test_api import READ, FakeCore, build, login

MACHINES = parse(
    json.dumps(
        [
            {"id": "a", "role": "dev+admin", "host": "127.0.0.1", "installDir": "/opt/ModernStreamingSystem", "core": {"url": "http://127.0.0.1:8080"}, "metrics": {"machine": "a"}},
            {"id": "meet", "role": "product-core", "host": "108.165.32.23", "ssh": "root@108.165.32.23", "installDir": "/opt/meet", "core": {"url": "http://127.0.0.1:19112"}, "metrics": {"machine": "fra"}},
            {"id": "b", "role": "media-node", "host": "152.234.227.199", "ssh": "root@152.234.227.199", "installDir": "/opt/cord/node", "metrics": {"machine": "hel"}},
        ]
    ),
    {},
)

TUNNEL = {"job": "nodes", "machine": "fra", "kind": "node"}
OLD_LOCAL = {"job": "node"}  # цель A до R212: метки machine нет
NEW_LOCAL = {"job": "node", "machine": "a", "kind": "local"}


def vector(*rows):
    return {"status": "success", "data": {"resultType": "vector", "result": [{"metric": m, "value": [1, str(v)]} for m, v in rows]}}


class FakeVictoria:
    """VictoriaMetrics: на каждый групповой запрос — свои строки; `fail` — запросы, которые отвечают 500."""

    def __init__(self, local=OLD_LOCAL, fail=()):
        self.queries = []
        self.fail = set(fail)
        core_local = {**local, "job": "core"}
        core_fra = {**TUNNEL, "kind": "core"}
        q = lambda name: LIVE[name][1].format(g=GROUP)  # noqa: E731
        self.answers = {
            q("up"): vector((local, 1), ({**local, "job": "livekit"}, 1), (TUNNEL, 1), ({**TUNNEL, "kind": "containers"}, 0), ({"job": "nodes", "machine": "hel", "kind": "node"}, 1), ({"job": "postgres"}, 1)),
            q("cores"): vector((local, 4), (TUNNEL, 6), ({"job": "nodes", "machine": "hel", "kind": "node"}, 2)),
            q("memTotalBytes"): vector((local, 8e9), (TUNNEL, 16e9)),
            q("memAvailableBytes"): vector((local, 2e9), (TUNNEL, 12e9)),
            q("diskTotalBytes"): vector((local, 100e9), (TUNNEL, 200e9)),
            q("diskFreeBytes"): vector((local, 25e9), (TUNNEL, 150e9)),
            q("cpu"): vector((local, 0.5), (TUNNEL, 0.25), ({"job": "nodes", "machine": "hel", "kind": "node"}, 0.75)),
            q("load1"): vector((local, 2.0), (TUNNEL, 3.0)),
            q("netOutMbps"): vector((local, 10), (TUNNEL, 30)),
            q("uname"): vector(
                ({**local, "release": "6.8.0", "nodename": "cord.nikg.tech", **({"machine": "x86_64"} if "machine" not in local else {"exported_machine": "x86_64"})}, 1),
                ({**TUNNEL, "release": "6.8.0", "nodename": "meet", "exported_machine": "aarch64"}, 1),
            ),
            q("os"): vector(({**local, "pretty_name": "Ubuntu 24.04"}, 1)),
            q("dmi"): vector(({**TUNNEL, "product_name": "KVM", "system_vendor": "Red Hat"}, 1)),
            q("rooms"): vector(({**core_local, "state": "live"}, 1), ({**core_local, "state": "waiting"}, 2), ({**core_fra, "state": "live"}, 3)),
            q("connected"): vector((core_local, 2), (core_fra, 7)),
            q("screens"): vector((core_fra, 1)),
            q("integrations"): vector(
                ({**core_local, **({"kind": "music"} if "kind" not in local else {"exported_kind": "music"})}, 1),
                ({**core_fra, "exported_kind": "watch"}, 2),
            ),
            q("loadShare"): vector(({**core_fra, "exported_kind": "cpu"}, 0.4)),
            q("nodeRooms"): vector(({**core_fra, "node": "fra"}, 3), ({**core_fra, "node": "hel"}, 1)),
            q("containerCpu"): vector(({**TUNNEL, "kind": "containers", "name": "core"}, 0.3), ({**TUNNEL, "kind": "containers", "name": "livekit"}, 0.9)),
            q("sfuMbps"): vector(({**local, "job": "livekit", "direction": "incoming"}, 4), ({**local, "job": "livekit", "direction": "outgoing"}, 6)),
            q("gatewayRps"): vector(({**TUNNEL, "kind": "gateway"}, 12)),
        }

    def handler(self, request: httpx.Request) -> httpx.Response:
        query = request.url.params.get("query", "")
        self.queries.append((request.url.path, query))
        name = next((n for n, (_, promql) in LIVE.items() if promql.format(g=GROUP) == query), None)
        if name in self.fail:
            return httpx.Response(500, text="boom")
        if request.url.path.endswith("/query_range"):
            if query == HISTORY["cpu"][1].format(g=GROUP):
                return httpx.Response(200, json={"status": "success", "data": {"result": [{"metric": TUNNEL, "values": [[100, "0.1"], [130, "0.2"]]}]}})
            return httpx.Response(200, json={"status": "success", "data": {"result": []}})
        return httpx.Response(200, json=self.answers.get(query, vector()))


def snapshot(fake):
    metrics = Metrics("http://vm", "", client=httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)))
    return asyncio.run(metrics.live(list(MACHINES)))


class LabelTest(unittest.TestCase):
    def test_sources_and_machines_from_target_labels(self):
        self.assertEqual(source_of({"job": "nodes", "kind": "containers"}), "containers")
        self.assertEqual(source_of({"job": "livekit", "machine": "a", "kind": "local"}), "sfu")
        self.assertEqual(source_of({"job": "core", "kind": "music"}), "core")
        self.assertIsNone(source_of({"job": "postgres"}))
        self.assertEqual(machine_label({"job": "nodes", "machine": "fra"}), "fra")
        self.assertEqual(machine_label({"job": "node", "machine": "a", "kind": "local"}), "a")
        # До R212 у A метки нет, а `machine` в ряду node_uname_info — архитектура, не машина.
        self.assertEqual(machine_label({"job": "node", "machine": "x86_64"}), "@local")


class LiveSnapshotTest(unittest.TestCase):
    def check(self, local):
        data = snapshot(FakeVictoria(local=local))
        self.assertIsNone(data["error"])
        a, meet, b = (data["machines"][k] for k in ("a", "meet", "b"))
        self.assertEqual(a["hardware"]["cores"], 4)
        self.assertEqual(a["hardware"]["arch"], "x86_64")
        self.assertEqual(a["hardware"]["os"], "Ubuntu 24.04")
        self.assertEqual(a["load"]["memUsed"], 0.75)
        self.assertEqual(a["load"]["diskUsed"], 0.75)
        self.assertEqual(a["load"]["load1"], 0.5)
        self.assertEqual(a["core"]["live"], 1)
        self.assertEqual(a["core"]["waiting"], 2)
        self.assertEqual(a["core"]["integrations"], {"music": 1})
        self.assertEqual(a["sfu"]["inMbps"], 4)
        self.assertEqual(a["sfu"]["outMbps"], 6)
        self.assertEqual(a["sources"]["node"], True)
        self.assertEqual(a["sources"]["sfu"], True)
        self.assertIsNone(a["sources"]["gateway"])
        self.assertEqual(meet["hardware"]["cores"], 6)
        self.assertEqual(meet["hardware"]["arch"], "aarch64")
        self.assertEqual(meet["hardware"]["virtualization"], "KVM · Red Hat")
        self.assertEqual(meet["load"]["cpu"], 0.25)
        self.assertEqual(meet["load"]["netOutMbps"], 30)
        self.assertEqual(meet["core"]["connected"], 7)
        self.assertEqual(meet["core"]["integrations"], {"watch": 2})
        self.assertEqual(meet["core"]["loadShare"], {"cpu": 0.4})
        self.assertEqual([n["node"] for n in meet["core"]["nodes"]], ["fra", "hel"])
        self.assertEqual([c["name"] for c in meet["containers"]], ["livekit", "core"])
        self.assertEqual(meet["gateway"]["rps"], 12)
        self.assertEqual(meet["sources"]["containers"], False)
        self.assertIsNone(meet["sfu"])
        self.assertEqual(b["load"]["cpu"], 0.75)
        self.assertIsNone(b["core"])

    def test_before_r212_the_local_machine_has_no_machine_label(self):
        self.check(OLD_LOCAL)

    def test_after_r212_the_local_machine_is_labelled_a(self):
        self.check(NEW_LOCAL)

    def test_a_failed_series_is_named_and_the_rest_still_shows(self):
        data = snapshot(FakeVictoria(fail={"cpu", "rooms"}))
        self.assertIn("cpu", data["error"])
        self.assertIn("rooms", data["error"])
        self.assertIsNone(data["machines"]["meet"]["load"]["cpu"])
        self.assertEqual(data["machines"]["meet"]["hardware"]["cores"], 6)

    def test_without_victoria_every_machine_is_empty_with_a_reason(self):
        def down(request):
            raise httpx.ConnectError("refused")

        metrics = Metrics("http://vm", "", client=httpx.AsyncClient(transport=httpx.MockTransport(down)))
        data = asyncio.run(metrics.live(list(MACHINES)))
        self.assertEqual(data["error"], "VictoriaMetrics не отвечает")
        self.assertIsNone(data["machines"]["a"]["load"]["cpu"])
        disabled = asyncio.run(Metrics("", "").live(list(MACHINES)))
        self.assertIn("monitoring", disabled["error"])

    def test_a_snapshot_is_reused_for_two_seconds(self):
        fake = FakeVictoria()
        metrics = Metrics("http://vm", "", client=httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)))

        async def twice():
            await metrics.live(list(MACHINES))
            await metrics.live(list(MACHINES))

        asyncio.run(twice())
        self.assertEqual(len(fake.queries), len(LIVE))

    def test_history_comes_per_machine(self):
        fake = FakeVictoria()
        metrics = Metrics("http://vm", "", client=httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)))
        data = asyncio.run(metrics.history(list(MACHINES), 30))
        self.assertEqual(data["machines"]["meet"]["cpu"], [[100, 0.1], [130, 0.2]])
        self.assertEqual(data["machines"]["a"]["cpu"], [])
        self.assertEqual(data["step"], 15)


class LiveApiTest(unittest.TestCase):
    def test_live_joins_metrics_with_each_cores_meetings(self):
        fake = FakeVictoria()
        client, state, core = build()
        state.metrics = Metrics("http://vm", "", client=httpx.AsyncClient(transport=httpx.MockTransport(fake.handler)))
        login(client)
        response = client.get("/api/fleet/live", headers=READ)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual([m["id"] for m in data["machines"]], ["a", "meet"])
        a = data["machines"][0]
        self.assertEqual(a["now"]["data"]["live"], 2)
        self.assertEqual(a["core"]["live"], 1)
        # Машины без меток в тестовом списке: ряды A — «эта машина», у meet меток нет — пусто.
        self.assertIsNone(data["machines"][1]["load"]["cpu"])
        self.assertEqual(data["totals"]["meetings"], 1)
        self.assertEqual(data["totals"]["busiest"], {"machine": "a", "cpu": 0.5})
        history = client.get("/api/fleet/live/history", params={"minutes": 60}, headers=READ)
        self.assertEqual(history.status_code, 200)
        self.assertEqual(client.get("/api/fleet/live/history", params={"minutes": 1}, headers=READ).status_code, 422)
        anonymous, _, _ = build()
        self.assertEqual(anonymous.get("/api/fleet/live", headers=READ).status_code, 401)

    def test_analytics_is_read_from_the_chosen_core_with_its_mode(self):
        class Core(FakeCore):
            def handler(self, request):
                if request.url.path == "/api/v1/admin/analytics":
                    self.calls.append(("GET", request.url.path, dict(request.url.params)))
                    return httpx.Response(200, json={"mode": request.url.params["mode"]})
                return super().handler(request)

        core = Core()
        client, _, _ = build(core=core)
        login(client)
        response = client.get("/api/fleet/core/meet/analytics", params={"from": "2026-11-01", "to": "2026-11-07", "mode": "ltv", "x": "1"}, headers=READ)
        self.assertEqual(response.json(), {"mode": "ltv"})
        self.assertIn(("GET", "/api/v1/admin/analytics", {"from": "2026-11-01", "to": "2026-11-07", "mode": "ltv"}), core.calls)


if __name__ == "__main__":
    unittest.main()


