"""Обращения всей системы (R215): пульт спрашивает ядро каждой машины с учётными данными, склеивает ящики,
ведёт обращение рычагами ядра той машины, откуда оно пришло, и пишет каждый рычаг в свой журнал."""

import json
import unittest

import httpx

from .test_api import HEADERS, READ, FakeCore, build, login

A_TICKET = "aaaaaaaa-0000-4000-8000-000000000001"
MEET_TICKET = "bbbbbbbb-0000-4000-8000-000000000002"


def ticket(id, created, priority="normal"):
    return {"id": id, "number": id[:8].upper(), "createdAt": created, "topic": "sound", "status": "NEW", "priority": priority, "message": "Не слышно"}


class SupportCore(FakeCore):
    """Два ядра за одним фейком: стенд (токен входа) и продукт (ключ пульта) отвечают своими ящиками."""

    def __init__(self, meet_down=False):
        super().__init__()
        self.meet_down = meet_down
        self.seen = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        token = request.headers.get("X-Cord-Admin")
        if not path.startswith("/api/v1/admin/support"):
            return super().handler(request)
        machine = "meet" if token == "fleet.product-key" else "a"
        body = json.loads(request.content) if request.content else None
        self.seen.append((machine, request.method, path, dict(request.url.params), request.headers.get("X-Cord-Admin-Actor"), body))
        if machine == "meet" and self.meet_down:
            raise httpx.ConnectError("refused")
        if path == "/api/v1/admin/support":
            return httpx.Response(200, json=[ticket(A_TICKET, 200)] if machine == "a" else [ticket(MEET_TICKET, 300, "urgent")])
        if path == "/api/v1/admin/support/counts":
            return httpx.Response(200, json={"fresh": 1, "open": 2, "waiting": 0, "done": 3, "archived": 4, "breached": 1, "unassigned": 1})
        if path == "/api/v1/admin/support/stats":
            return httpx.Response(200, json={"days": int(request.url.params["days"]), "created": 5})
        if path.endswith("/notes"):
            return httpx.Response(200, json={"id": 7, "kind": body["kind"], "text": body["text"]})
        if request.method == "PUT":
            return httpx.Response(204)
        return httpx.Response(200, json={"ticket": ticket(path.rsplit("/", 1)[1], 100), "notes": [{"id": 1, "kind": "status"}]})


class InboxTest(unittest.TestCase):
    def test_inboxes_of_all_cores_are_merged_and_tagged(self):
        core = SupportCore()
        client, _, _ = build(core=core)
        login(client)
        data = client.get("/api/fleet/support", params={"status": "NEW", "q": "звук", "evil": "1"}, headers=READ).json()
        self.assertEqual([(t["id"], t["machine"]) for t in data["tickets"]], [(MEET_TICKET, "meet"), (A_TICKET, "a")])
        self.assertEqual(data["errors"], [])
        # Фильтры уходят в каждое ядро; чужие параметры — нет.
        self.assertEqual({s[0] for s in core.seen}, {"a", "meet"})
        self.assertTrue(all(s[3] == {"status": "NEW", "q": "звук"} for s in core.seen))
        oldest = client.get("/api/fleet/support", params={"sort": "OLD"}, headers=READ).json()
        self.assertEqual([t["id"] for t in oldest["tickets"]], [A_TICKET, MEET_TICKET])
        urgent = client.get("/api/fleet/support", params={"sort": "PRIORITY", "limit": 1}, headers=READ).json()
        self.assertEqual([t["id"] for t in urgent["tickets"]], [MEET_TICKET])
        self.assertTrue(urgent["more"])
        only_a = client.get("/api/fleet/support", params={"machine": "a"}, headers=READ).json()
        self.assertEqual([t["machine"] for t in only_a["tickets"]], ["a"])

    def test_a_silent_core_is_an_error_line_and_the_rest_shows(self):
        client, _, _ = build(core=SupportCore(meet_down=True))
        login(client)
        data = client.get("/api/fleet/support", headers=READ).json()
        self.assertEqual([t["machine"] for t in data["tickets"]], ["a"])
        self.assertEqual(data["errors"][0]["machine"], "meet")
        self.assertEqual(data["errors"][0]["code"], "CORE_UNREACHABLE")

    def test_counts_are_summed_and_stats_kept_per_machine(self):
        client, _, _ = build(core=SupportCore())
        login(client)
        counts = client.get("/api/fleet/support/counts", headers=READ).json()
        self.assertEqual(counts["total"]["archived"], 8)
        self.assertEqual(counts["total"]["breached"], 2)
        self.assertEqual(counts["machines"]["meet"]["data"]["open"], 2)
        stats = client.get("/api/fleet/support/stats", params={"days": 7}, headers=READ).json()
        self.assertEqual(stats["machines"]["a"]["data"]["days"], 7)


class LeverTest(unittest.TestCase):
    def test_a_ticket_is_worked_on_its_own_machine_and_audited(self):
        core = SupportCore()
        client, state, _ = build(core=core)
        login(client)
        opened = client.get(f"/api/fleet/support/meet/{MEET_TICKET}", headers=READ).json()
        self.assertEqual(opened["ticket"]["machine"], "meet")
        self.assertEqual(opened["notes"][0]["kind"], "status")

        status = client.put(f"/api/fleet/support/meet/{MEET_TICKET}/status", json={"status": "WAITING"}, headers=HEADERS)
        self.assertEqual(status.status_code, 204)
        update = client.put(f"/api/fleet/support/meet/{MEET_TICKET}", json={"assignee": "owner", "priority": "high"}, headers=HEADERS)
        self.assertEqual(update.status_code, 204)
        note = client.post(f"/api/fleet/support/meet/{MEET_TICKET}/notes", json={"kind": "reply", "text": "Позвоните по +7 900 000-00-00"}, headers=HEADERS)
        self.assertEqual(note.json()["id"], 7)
        writes = [s for s in core.seen if s[1] != "GET"]
        self.assertEqual([s[0] for s in writes], ["meet", "meet", "meet"])
        self.assertTrue(all(s[4] == "owner" for s in writes))
        self.assertEqual(writes[1][5], {"assignee": "owner", "priority": "high"})

        rows = state.store.audit_query(action="support")
        self.assertEqual([r["action"] for r in rows], ["support.note", "support.update", "support.status"])
        self.assertEqual(rows[0]["target"], f"meet:{MEET_TICKET}")
        # Текст ответа (в нём бывает контакт человека) в журнал пульта не идёт.
        self.assertEqual(rows[0]["args"], {"kind": "reply"})
        self.assertNotIn("900", json.dumps(rows, ensure_ascii=False))

    def test_bad_input_is_refused_before_the_core(self):
        core = SupportCore()
        client, _, _ = build(core=core)
        login(client)
        self.assertEqual(client.put(f"/api/fleet/support/meet/{MEET_TICKET}/status", json={"status": "LOST"}, headers=HEADERS).status_code, 422)
        self.assertEqual(client.put("/api/fleet/support/meet/not-a-uuid/status", json={"status": "OPEN"}, headers=HEADERS).status_code, 400)
        self.assertEqual(client.put(f"/api/fleet/support/meet/{MEET_TICKET}", json={}, headers=HEADERS).status_code, 400)
        self.assertEqual(client.post(f"/api/fleet/support/meet/{MEET_TICKET}/notes", json={"kind": "status", "text": "x"}, headers=HEADERS).status_code, 422)
        self.assertEqual(client.get(f"/api/fleet/support/nope/{MEET_TICKET}", headers=READ).json()["code"], "MACHINE_UNKNOWN")
        # Без заголовка пульта изменения не проходят (CSRF).
        self.assertEqual(client.put(f"/api/fleet/support/meet/{MEET_TICKET}/status", json={"status": "OPEN"}, headers=READ).status_code, 403)
        self.assertEqual([s for s in core.seen if s[1] != "GET"], [])

    def test_a_machine_without_core_credentials_has_no_inbox(self):
        machines = json.dumps(
            [
                {"id": "a", "role": "dev+admin", "host": "127.0.0.1", "installDir": "/opt", "core": {"url": "http://127.0.0.1:8080"}},
                {"id": "cordcam", "role": "media-node", "host": "157.22.241.114", "ssh": "root@157.22.241.114", "installDir": "/opt", "core": {"url": "http://127.0.0.1:19122"}},
            ]
        )
        client, _, _ = build(machines_json=machines, core=SupportCore())
        login(client)
        data = client.get("/api/fleet/support", headers=READ).json()
        self.assertEqual(data["skipped"], ["cordcam"])
        self.assertEqual(client.get(f"/api/fleet/support/cordcam/{A_TICKET}", headers=READ).json()["code"], "MACHINE_NO_CORE")


if __name__ == "__main__":
    unittest.main()
