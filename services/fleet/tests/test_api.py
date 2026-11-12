import json
import tempfile
import unittest
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from fleet.app import App, create_app
from fleet.auth import hash_password, totp
from fleet.executor import DryRunExecutor, FakeExecutor
from fleet.machines import Machines, parse
from fleet.metrics import Metrics
from fleet.settings import Settings
from fleet.store import Store

SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
PASSWORD = "пароль-пульта"
HEADERS = {"X-Fleet-Request": "1", "Origin": "http://testserver", "X-Real-IP": "203.0.113.5"}
READ = {"X-Real-IP": "203.0.113.5"}


class FakeCore:
    """Ядро стенда глазами пульта: вход паролем, `now`, окно работ, узлы, рычаги."""

    def __init__(self):
        self.calls = []
        self.maintenance = {"phase": "none", "window": None, "closed": None, "now": "2026-11-08T12:00:00Z"}

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.method, request.url.path, request.headers.get("X-Cord-Admin")))
        path = request.url.path
        if path == "/api/v1/admin/session":
            body = json.loads(request.content)
            if body.get("password") != "stand-password":
                return httpx.Response(401, json={"status": 401, "code": "ADMIN_PASSWORD_INVALID", "detail": "Неверный пароль владельца"})
            return httpx.Response(200, json={"token": "T.sig", "expiresAt": 9999999999})
        if path == "/api/v1/nodes":
            return httpx.Response(200, json=[{"id": "fra", "title": {"ru": "Франкфурт"}, "country": "DE", "control": True, "level": 1, "state": "ok"}])
        if request.headers.get("X-Cord-Admin") not in ("T.sig", "fleet.product-key"):
            return httpx.Response(401, json={"status": 401, "code": "ADMIN_REQUIRED", "detail": "Войдите паролем владельца сервера"})
        if path == "/api/v1/admin/now":
            return httpx.Response(200, json={"serverTime": 1, "live": 2, "humans": 9, "connected": 9, "waiting": 0, "bots": 0, "screens": 1, "rooms": []})
        if path == "/api/v1/admin/maintenance/window":
            if request.method == "DELETE":
                self.maintenance = {**self.maintenance, "closed": "cancelled"}
            return httpx.Response(200, json=self.maintenance)
        if path == "/api/v1/admin/maintenance/window/now":
            self.maintenance = {"phase": "grace", "window": {"id": "w1", "kind": "emergency", **json.loads(request.content)}, "closed": None, "now": "x"}
            return httpx.Response(200, json=self.maintenance)
        if path == "/api/v1/admin/maintenance":
            return httpx.Response(200, json={"on": json.loads(request.content)["on"], "since": 1})
        if path.startswith("/api/v1/admin/rooms/") and path.endswith("/close"):
            return httpx.Response(200, json={"serverTime": 1, "live": 1, "rooms": []})
        if path.startswith("/api/v1/admin/insight/"):
            self.insight = (request.url.raw_path.decode(), dict(request.url.params))
            if path.endswith("/nothing"):
                return httpx.Response(404, json={"status": 404, "code": "NOT_FOUND", "detail": "нет такого раздела"})
            return httpx.Response(200, json={"section": path.rsplit("/insight/", 1)[1], "data": {}})
        if path == "/api/v1/admin/meetings":
            return httpx.Response(200, json={"from": request.url.params["from"], "meetings": 3})
        if path == "/api/v1/admin/participants":
            self.participants = dict(request.url.params)
            row = {"id": "p1", "roomCode": "123456789", "name": "Анна", "ip": "2001:db8:0:0:0:0:0:7", "joinedAt": 1, "leftAt": None}
            return httpx.Response(200, json={"items": [row], "next": None})
        return httpx.Response(404, json={"status": 404, "code": "NOT_FOUND", "detail": path})


def build(settings=None, machines_json=None, core=None, registry_dir=None):
    core = core or FakeCore()
    registry = ""
    if registry_dir:
        registry = str(Path(registry_dir) / "registry.json")
        Path(registry).write_text(json.dumps({"format": "cord.nodes/1", "nodes": [{"id": "fra", "control": True, "ip": "108.165.32.75"}, {"id": "msk", "ip": "157.22.241.114", "enabled": True}]}))
    machines_json = machines_json or json.dumps(
        [
            {"id": "a", "role": "dev+admin", "host": "127.0.0.1", "installDir": "/opt/ModernStreamingSystem", "core": {"url": "http://127.0.0.1:8080"}, "nodeId": "fra", "registry": registry},
            {"id": "meet", "role": "product-core", "host": "108.165.32.23", "ssh": "root@108.165.32.23", "sshKey": "/keys/cord_fra", "installDir": "/opt/meet/ModernStreamingSystem", "core": {"url": "http://127.0.0.1:28080"}, "product": "cord.online"},
        ]
    )
    settings = settings or Settings(
        password_hash=hash_password(PASSWORD), totp_secret=SECRET, insecure_dev=True, agent_key="agent-key", core_credentials={"a": "password:stand-password", "meet": "key:product-key"}
    )
    store = Store(":memory:")
    machines = Machines(parse(machines_json, settings.core_credentials))
    state = App(
        settings,
        store,
        machines,
        live_executor=FakeExecutor(),
        dry_executor=DryRunExecutor(),
        metrics=Metrics("", ""),
        core_client=httpx.AsyncClient(transport=httpx.MockTransport(core.handler)),
    )
    app = create_app(state)
    client = TestClient(app)
    client.__enter__()
    return client, state, core


def login(client):
    response = client.post("/api/fleet/auth/login", json={"password": PASSWORD, "code": totp(SECRET)}, headers=HEADERS)
    assert response.status_code == 204, response.text
    return client


class AccessTest(unittest.TestCase):
    def test_health_is_open_and_everything_else_is_not(self):
        client, _, _ = build()
        self.assertEqual(client.get("/api/fleet/health").json()["enabled"], True)
        self.assertEqual(client.get("/api/fleet/overview", headers=READ).status_code, 401)
        self.assertEqual(client.get("/api/fleet/overview", headers=READ).json()["code"], "AUTH_REQUIRED")
        self.assertEqual(client.get("/other", headers=READ).status_code, 404)

    def test_disabled_fleet_answers_404(self):
        client, _, _ = build(settings=Settings(insecure_dev=True))
        self.assertEqual(client.get("/api/fleet/health").json()["enabled"], False)
        response = client.post("/api/fleet/auth/login", json={"password": "x", "code": "000000"}, headers=HEADERS)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["code"], "AUTH_DISABLED")

    def test_allowlist_hides_the_panel(self):
        import ipaddress

        settings = Settings(password_hash=hash_password(PASSWORD), totp_secret=SECRET, insecure_dev=True, allow_ips=(ipaddress.ip_network("198.51.100.0/24"),))
        client, _, _ = build(settings=settings)
        response = client.post("/api/fleet/auth/login", json={"password": PASSWORD, "code": totp(SECRET)}, headers=HEADERS)
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.text, "")
        ok = client.post("/api/fleet/auth/login", json={"password": PASSWORD, "code": totp(SECRET)}, headers={**HEADERS, "X-Real-IP": "198.51.100.7"})
        self.assertEqual(ok.status_code, 204)

    def test_login_sets_cookie_and_me_works(self):
        client, state, _ = build()
        login(client)
        self.assertIn("fleet", client.cookies)
        me = client.get("/api/fleet/auth/me", headers=READ).json()
        self.assertEqual(me["actor"], "owner")
        self.assertEqual(me["executor"]["mode"], "dry-run")
        sessions = client.get("/api/fleet/auth/sessions", headers=READ).json()
        self.assertEqual(len(sessions), 1)
        self.assertTrue(sessions[0]["current"])
        self.assertEqual(sessions[0]["ip"], "203.0.113.5")
        self.assertEqual(client.post("/api/fleet/auth/logout", headers=HEADERS).status_code, 204)
        self.assertEqual(client.get("/api/fleet/auth/me", headers=READ).status_code, 401)
        actions = [row["action"] for row in state.store.audit_query()]
        self.assertEqual(actions, ["auth.logout", "auth.login"])

    def test_bad_login_is_refused_and_audited(self):
        client, state, _ = build()
        response = client.post("/api/fleet/auth/login", json={"password": PASSWORD, "code": "000000"}, headers=HEADERS)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["detail"], "Неверный пароль или код")
        self.assertEqual(state.store.audit_query()[0]["outcome"], "refused")

    def test_csrf_header_and_origin_are_required(self):
        client, _, _ = build()
        no_header = client.post("/api/fleet/auth/login", json={"password": PASSWORD, "code": totp(SECRET)}, headers={"Origin": "http://testserver", "X-Real-IP": "1.2.3.4"})
        self.assertEqual(no_header.status_code, 403)
        wrong_origin = client.post("/api/fleet/auth/login", json={"password": PASSWORD, "code": totp(SECRET)}, headers={**HEADERS, "Origin": "https://evil.test"})
        self.assertEqual(wrong_origin.status_code, 403)
        login(client)
        response = client.post("/api/fleet/core/a/drain", json={"on": True}, headers={"X-Real-IP": "203.0.113.5"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["code"], "CSRF_REJECTED")

    def test_agent_key_only_from_localhost(self):
        client, _, _ = build()
        via_gateway = client.get("/api/fleet/overview", headers={"X-Fleet-Agent": "agent-key", "X-Real-IP": "203.0.113.5"})
        self.assertEqual(via_gateway.status_code, 401)
        local = client.get("/api/fleet/overview", headers={"X-Fleet-Agent": "agent-key"})
        self.assertEqual(local.status_code, 200)
        me = client.get("/api/fleet/auth/me", headers={"X-Fleet-Agent": "agent-key"}).json()
        self.assertEqual(me["actor"], "agent")
        # Агенту по умолчанию нельзя выкатывать и закрывать встречи, можно — окно работ.
        deploy = client.post("/api/fleet/jobs", json={"kind": "deploy", "machine": "a", "args": {"services": ["core"]}, "dryRun": True}, headers={"X-Fleet-Agent": "agent-key"})
        self.assertEqual(deploy.status_code, 403)
        window = client.post("/api/fleet/core/a/maintenance/now", json={"graceSeconds": 60, "reason": "Обновление"}, headers={"X-Fleet-Agent": "agent-key"})
        self.assertEqual(window.status_code, 200)
        sessions = client.delete("/api/fleet/auth/sessions", headers={"X-Fleet-Agent": "agent-key"})
        self.assertEqual(sessions.status_code, 403)


class EdgeCertTest(unittest.TestCase):
    """R211: «только по сертификату» — сертификат проверяет `edge`, шлюз пульта ставит `X-Cord-Edge-Cert`."""

    def test_verified_certificate_via_the_admin_gateway_is_the_owner(self):
        client, _, _ = build(settings=Settings(edge_cert=True, insecure_dev=True, core_credentials={"a": "password:stand-pass"}))
        headers = {"X-Cord-Edge-Cert": "verified", "X-Real-IP": "203.0.113.7"}
        self.assertEqual(client.get("/api/fleet/overview", headers={**READ, **headers}).status_code, 200)
        me = client.get("/api/fleet/auth/me", headers={**READ, **headers}).json()
        self.assertEqual((me["actor"], me["auth"]), ("owner", "edge-cert"))

    def test_without_the_gateway_or_the_mode_the_header_means_nothing(self):
        cert = Settings(edge_cert=True, insecure_dev=True)
        client, _, _ = build(settings=cert)
        # Без X-Real-IP — запрос не через шлюз пульта (кто-то на самой машине): заголовок не принимается.
        self.assertEqual(client.get("/api/fleet/overview", headers={"X-Cord-Edge-Cert": "verified"}).status_code, 401)
        # Режим выключен — заголовок ничего не значит.
        client, _, _ = build()
        headers = {"X-Cord-Edge-Cert": "verified", "X-Real-IP": "203.0.113.7"}
        self.assertEqual(client.get("/api/fleet/overview", headers={**READ, **headers}).status_code, 401)

    def test_changes_still_need_the_console_header_and_origin(self):
        client, _, _ = build(settings=Settings(edge_cert=True, insecure_dev=True, admin_host="admin.callcord.ru"))
        cert = {"X-Cord-Edge-Cert": "verified", "X-Real-IP": "203.0.113.7"}
        bare = client.post("/api/fleet/core/a/maintenance/now", json={"graceSeconds": 60, "reason": "x"}, headers=cert)
        self.assertEqual(bare.status_code, 403)


class OverviewTest(unittest.TestCase):
    def test_overview_reads_cores_and_tolerates_failures(self):
        client, _, core = build()
        login(client)
        data = client.get("/api/fleet/overview", headers=READ).json()
        self.assertEqual([m["id"] for m in data["machines"]], ["a", "meet"])
        a = data["machines"][0]
        self.assertEqual(a["now"]["data"]["humans"], 9)
        self.assertEqual(a["maintenance"]["data"]["phase"], "none")
        self.assertIn("monitoring", a["metrics"]["error"])
        self.assertEqual(data["alerts"]["alerts"], [])
        self.assertEqual(data["executor"]["mode"], "dry-run")
        # Ключ пульта продукта идёт токеном `fleet.<ключ>` без входа.
        self.assertIn(("GET", "/api/v1/admin/now", "fleet.product-key"), core.calls)
        self.assertIn(("POST", "/api/v1/admin/session", None), core.calls)

    def test_unreachable_core_is_an_error_block_not_a_crash(self):
        def down(request):
            raise httpx.ConnectError("refused")

        class Down(FakeCore):
            def handler(self, request):
                return down(request)

        client, _, _ = build(core=Down())
        login(client)
        data = client.get("/api/fleet/overview", headers=READ).json()
        self.assertIsNone(data["machines"][0]["now"]["data"])
        self.assertEqual(data["machines"][0]["now"]["error"]["code"], "CORE_UNREACHABLE")

    def test_core_reads_pass_filters(self):
        client, _, core = build()
        login(client)
        meetings = client.get("/api/fleet/core/a/meetings", params={"from": 1, "to": 2, "tz": 3, "evil": "x"}, headers=READ)
        self.assertEqual(meetings.status_code, 200)
        self.assertEqual(client.get("/api/fleet/core/a/reboot", headers=READ).status_code, 404)
        self.assertEqual(client.get("/api/fleet/core/nope/now", headers=READ).json()["code"], "MACHINE_UNKNOWN")
        self.assertEqual(client.get("/api/fleet/core/a/nodes", headers=READ).json()[0]["id"], "fra")

    def test_insight_reports_come_from_the_core_of_the_chosen_environment(self):
        # R239: пульт называет среду и раздел; `fleet` спрашивает ядро этой среды и передаёт только параметры отчёта.
        client, _, core = build()
        login(client)
        params = {"env": "dev", "from": "2026-11-01", "to": "2026-11-12", "view": "cohort", "strict": 1, "compare": 1, "evil": "x"}
        pulse = client.get("/api/fleet/insight/pulse", params=params, headers=READ)
        self.assertEqual(pulse.status_code, 200, pulse.text)
        self.assertEqual(pulse.json()["section"], "pulse")
        path, sent = core.insight
        self.assertTrue(path.startswith("/api/v1/admin/insight/pulse?"))
        self.assertEqual(sent, {"from": "2026-11-01", "to": "2026-11-12", "view": "cohort", "strict": "1", "compare": "1"})
        # Ключ группы ошибок доходит до ядра целиком, а лишнего в пути не появляется.
        group = client.get("/api/fleet/insight/errors/ROOM_FULL~join~1.4", params={"env": "dev", "from": "2026-11-01", "to": "2026-11-12"}, headers=READ)
        self.assertEqual(group.json()["section"], "errors/ROOM_FULL~join~1.4")
        spaced = client.get("/api/fleet/insight/errors/Type Error~app~1.4", params={"env": "dev"}, headers=READ)
        self.assertEqual(spaced.status_code, 200)
        self.assertEqual(core.insight[0].split("?")[0], "/api/v1/admin/insight/errors/Type%20Error~app~1.4")
        # Знаки, которыми путь ядра можно было бы продолжить или оборвать, в ключе не бывают — отказ без запроса к ядру.
        before = len(core.calls)
        self.assertEqual(client.get("/api/fleet/insight/errors/a%3Fb%23c", params={"env": "dev"}, headers=READ).status_code, 404)
        self.assertEqual(len(core.calls), before)
        # Отказ ядра и службы доходит как есть; чужой раздел и чужая среда — отказ самого `fleet`.
        self.assertEqual(client.get("/api/fleet/insight/nothing", params={"env": "dev"}, headers=READ).status_code, 404)
        self.assertEqual(client.get("/api/fleet/insight/a/b/c", params={"env": "dev"}, headers=READ).status_code, 404)
        self.assertEqual(client.get("/api/fleet/insight/pulse", params={"env": "moon"}, headers=READ).status_code, 422)
        stranger, _, _ = build()
        self.assertEqual(stranger.get("/api/fleet/insight/pulse", params={"env": "dev"}, headers=READ).status_code, 401)

    def test_participants_of_a_meeting_or_a_period_reach_the_console(self):
        # Р-134: «Встречи → участники» — журнал ядра с полным адресом, фильтры встречи, периода и адреса.
        client, _, core = build()
        login(client)
        params = {"code": "123456789", "from": 1, "to": 2, "ip": "2001:db8", "cursor": "1.x", "limit": 50, "evil": "x"}
        answer = client.get("/api/fleet/core/a/participants", params=params, headers=READ)
        self.assertEqual(answer.status_code, 200)
        self.assertEqual(answer.json()["items"][0]["ip"], "2001:db8:0:0:0:0:0:7")
        self.assertEqual(core.participants, {"code": "123456789", "from": "1", "to": "2", "ip": "2001:db8", "cursor": "1.x", "limit": "50"})


class LeverTest(unittest.TestCase):
    def test_maintenance_window_is_proxied_and_audited(self):
        client, state, core = build()
        login(client)
        started = client.post("/api/fleet/core/a/maintenance/now", json={"graceSeconds": 120, "reason": "Обновление"}, headers=HEADERS)
        self.assertEqual(started.status_code, 200)
        self.assertEqual(started.json()["phase"], "grace")
        finished = client.delete("/api/fleet/core/a/maintenance", headers=HEADERS)
        self.assertEqual(finished.status_code, 200)
        self.assertEqual(finished.json()["closed"], "cancelled")
        rows = state.store.audit_query(action="maintenance")
        self.assertEqual([r["action"] for r in rows], ["maintenance.finish", "maintenance.now"])
        self.assertEqual(rows[1]["args"], {"graceSeconds": 120, "reason": "Обновление"})
        self.assertEqual(rows[1]["target"], "a")

    def test_core_refusal_is_passed_through_and_audited(self):
        client, state, _ = build()
        login(client)
        response = client.post("/api/fleet/core/meet/rooms/00000000-0000-0000-0000-00000000dead/close", json={"blockCreator": True}, headers=HEADERS)
        self.assertEqual(response.status_code, 200)
        unknown = client.post("/api/fleet/core/meet/blocks", json={"kind": "ip", "subject": "abc"}, headers=HEADERS)
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(unknown.json()["source"], "core")
        self.assertEqual(state.store.audit_query(action="block.add")[0]["outcome"], "refused")

    def test_drain_toggle(self):
        client, _, core = build()
        login(client)
        self.assertEqual(client.post("/api/fleet/core/a/drain", json={"on": True}, headers=HEADERS).json()["on"], True)


class JobsApiTest(unittest.TestCase):
    def test_dry_run_job_lifecycle(self):
        client, state, _ = build()
        login(client)
        created = client.post("/api/fleet/jobs", json={"kind": "deploy", "machine": "meet", "args": {"services": ["gateway", "core"], "drain": True}, "dryRun": True}, headers=HEADERS)
        self.assertEqual(created.status_code, 200, created.text)
        job = created.json()
        self.assertTrue(job["dryRun"])
        import asyncio

        asyncio.run(state.jobs.wait(job["id"]))
        detail = client.get(f"/api/fleet/jobs/{job['id']}", headers=READ).json()
        self.assertEqual(detail["job"]["status"], "ok")
        texts = [line["text"] for line in detail["lines"]]
        self.assertIn("1. $ backlog/bin/deploy.sh --drain gateway core", texts)
        after = client.get(f"/api/fleet/jobs/{job['id']}", params={"after": detail["lines"][-1]["n"]}, headers=READ).json()
        self.assertEqual(after["lines"], [])
        listed = client.get("/api/fleet/jobs", params={"machine": "meet"}, headers=READ).json()
        self.assertEqual(listed[0]["id"], job["id"])
        actions = [r["action"] for r in state.store.audit_query(action="job")]
        self.assertEqual(actions, ["job.deploy", "job.start"])

    def test_live_job_is_refused_while_executor_is_disabled(self):
        client, state, _ = build()
        login(client)
        response = client.post("/api/fleet/jobs", json={"kind": "status", "machine": "meet", "dryRun": False}, headers=HEADERS)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["code"], "EXECUTOR_DISABLED")
        self.assertEqual(state.store.audit_query(action="job.start")[0]["outcome"], "refused")
        bad = client.post("/api/fleet/jobs", json={"kind": "deploy", "machine": "meet", "args": {"services": ["x; reboot"]}}, headers=HEADERS)
        self.assertEqual(bad.status_code, 400)

    def test_node_actions_and_add_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            client, state, _ = build(registry_dir=tmp)
            login(client)
            nodes = client.get("/api/fleet/nodes/a", headers=READ).json()
            self.assertEqual([n["id"] for n in nodes["registry"]["nodes"]], ["fra", "msk"])
            self.assertEqual(nodes["levels"]["data"][0]["id"], "fra")
            remote = client.get("/api/fleet/nodes/meet", headers=READ).json()
            self.assertIsNone(remote["registry"])
            self.assertIn("SSH", remote["registryError"])
            drained = client.post("/api/fleet/nodes/a/msk/drain", json={"dryRun": True}, headers=HEADERS)
            self.assertEqual(drained.status_code, 200, drained.text)
            self.assertEqual(drained.json()["kind"], "node.drain")
            form = {"id": "hel", "ip": "152.234.227.199", "product": "cord.online", "country": "FI", "titleRu": "Хельсинки", "titleEn": "Helsinki", "maxRooms": 2, "uplinkMbps": 1000, "cores": 2, "dnsReady": True}
            plan = client.post("/api/fleet/nodes/a/add", json={"form": form, "dryRun": True}, headers=HEADERS)
            self.assertEqual(plan.status_code, 200, plan.text)
            self.assertEqual(plan.json()["dns"][0]["name"], "hel.cord.online")
            self.assertEqual(len(plan.json()["plan"]), 5)
            self.assertIsNone(plan.json()["job"])
            taken = client.post("/api/fleet/nodes/a/add", json={"form": {**form, "id": "msk"}, "dryRun": True}, headers=HEADERS)
            self.assertEqual(taken.status_code, 409)
            self.assertEqual(client.post("/api/fleet/nodes/a/msk/explode", json={}, headers=HEADERS).status_code, 404)

    def test_audit_query_and_export(self):
        client, _, _ = build()
        login(client)
        rows = client.get("/api/fleet/audit", params={"action": "auth"}, headers=READ).json()
        self.assertEqual(rows[0]["action"], "auth.login")
        export = client.get("/api/fleet/audit/export", headers=READ)
        self.assertEqual(export.status_code, 200)
        self.assertIn("auth.login", export.text)
        self.assertEqual(export.headers["content-type"].split(";")[0], "application/x-ndjson")


if __name__ == "__main__":
    unittest.main()
