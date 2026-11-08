import unittest

from fleet import catalog
from fleet.errors import Problem
from fleet.machines import Machine

MEET = Machine(id="meet", role="product-core", host="108.165.32.23", install_dir="/opt/meet/ModernStreamingSystem", ssh="root@108.165.32.23", ssh_key="/keys/cord_fra", node_id="fra")


class CatalogTest(unittest.TestCase):
    def test_every_operation_builds_argv_lists(self):
        samples = {
            "status": {},
            "logs": {"service": "core", "tail": 50},
            "active-meetings": {"node": "msk"},
            "env-flags": {},
            "deploy": {"services": ["gateway", "core"], "drain": True},
            "rollback": {"commit": "5b4718f", "services": "core"},
            "node.check": {"node": "msk"},
            "node.logs": {"node": "msk", "service": "livekit"},
            "node.drain": {"node": "msk"},
            "node.undrain": {"node": "msk"},
            "node.deploy": {"node": "msk"},
            "node.update": {"node": "msk"},
            "node.remove": {"node": "msk", "confirm": "msk"},
            "publish-windows": {"version": "1.2.3"},
        }
        self.assertEqual(set(samples) | {"node.add"}, set(catalog.OPERATIONS))
        for kind, args in samples.items():
            steps = catalog.plan(kind, MEET, args)
            self.assertTrue(steps, kind)
            for step in steps:
                self.assertIsInstance(step, list, kind)
                self.assertTrue(all(isinstance(part, str) for part in step), kind)
                self.assertNotIn("sh", step[:1], kind)

    def test_deploy_plan(self):
        steps = catalog.plan("deploy", MEET, {"services": ["core", "gateway"], "drain": True, "ref": "release/1.2"})
        self.assertEqual(
            steps,
            [
                ["git", "fetch", "-q", "origin"],
                ["git", "checkout", "-q", "--detach", "release/1.2"],
                ["backlog/bin/deploy.sh", "--drain", "core", "gateway"],
            ],
        )
        forced = catalog.plan("deploy", MEET, {"services": "services", "force": "true"})
        self.assertEqual(forced, [["env", "CORD_DEPLOY_FORCE=1", "backlog/bin/deploy.sh", "services"]])

    def test_injection_is_rejected_before_any_command(self):
        bad = [
            ("deploy", {"services": ["core; rm -rf /"]}),
            ("deploy", {"services": ["core"], "ref": "main; reboot"}),
            ("deploy", {"services": ["core"], "ref": "../../etc"}),
            ("deploy", {"services": []}),
            ("rollback", {"commit": "$(id)", "services": ["core"]}),
            ("logs", {"service": "core", "tail": 100000}),
            ("logs", {"service": "evil"}),
            ("node.drain", {"node": "msk && reboot"}),
            ("node.drain", {"node": "Msk"}),
            ("node.remove", {"node": "msk", "confirm": "ms"}),
            ("publish-windows", {"version": "1.2"}),
            ("node.logs", {"node": "msk", "service": "core"}),
        ]
        for kind, args in bad:
            with self.assertRaises(Problem, msg=f"{kind} {args}") as caught:
                catalog.plan(kind, MEET, args)
            self.assertEqual(caught.exception.status, 400, kind)
            self.assertEqual(caught.exception.code, "OPERATION_INVALID", kind)
        with self.assertRaises(Problem) as caught:
            catalog.plan("reboot", MEET, {})
        self.assertEqual(caught.exception.status, 404)

    def test_node_add_plan_matches_reference(self):
        form = {
            "id": "msk",
            "ip": "157.22.241.114",
            "product": "cordcam.ru",
            "country": "ru",
            "titleRu": "Москва",
            "titleEn": "Moscow",
            "maxRooms": 4,
            "uplinkMbps": 500,
            "cores": 2,
            "sshKey": "/root/.ssh/cord_msk",
            "dnsReady": True,
        }
        fields = catalog.node_add_args(form)
        self.assertEqual(fields["app"], "msk.cordcam.ru")
        self.assertEqual(fields["rtc"], "rtc-msk.cordcam.ru")
        self.assertEqual(fields["turn"], "turn-msk.cordcam.ru")
        self.assertEqual(fields["ssh"], "root@157.22.241.114")
        self.assertEqual(
            catalog.node_add_dns(fields),
            [
                {"name": "msk.cordcam.ru", "type": "A", "value": "157.22.241.114", "proxied": False},
                {"name": "rtc-msk.cordcam.ru", "type": "A", "value": "157.22.241.114", "proxied": False},
                {"name": "turn-msk.cordcam.ru", "type": "A", "value": "157.22.241.114", "proxied": False},
            ],
        )
        steps = [catalog.shell_words(step) for step in catalog.plan("node.add", MEET, form)]
        self.assertEqual(
            steps,
            [
                "node scripts/node-config.mjs --node=msk --ip=157.22.241.114 --app=msk.cordcam.ru --rtc=rtc-msk.cordcam.ru "
                "--turn=turn-msk.cordcam.ru '--title-ru=Москва' --title-en=Moscow --country=RU --max-rooms=4 --uplink-mbps=500 "
                "--cores=2 --ssh=root@157.22.241.114 --ssh-key=/root/.ssh/cord_msk",
                "node scripts/node-config.mjs --write-env",
                "backlog/bin/node.sh msk bootstrap",
                "backlog/bin/node.sh msk deploy",
                "backlog/bin/node.sh msk check",
            ],
        )

    def test_node_add_without_dns_uses_ip_mode(self):
        form = {"id": "hel", "ip": "152.234.227.199", "product": "cordcam.ru", "country": "FI", "titleRu": "Хельсинки", "titleEn": "Helsinki", "maxRooms": 2, "uplinkMbps": 1000, "cores": 2}
        first = catalog.plan("node.add", MEET, form)[0]
        self.assertIn("--mode=ip", first)
        self.assertFalse(any(part.startswith("--app=") for part in first))

    def test_node_add_rejects_bad_fields(self):
        base = {"id": "hel", "ip": "152.234.227.199", "product": "cordcam.ru", "country": "FI", "titleRu": "Хельсинки", "titleEn": "Helsinki", "maxRooms": 2, "uplinkMbps": 1000, "cores": 2}
        for key, value in (("id", "HEL"), ("ip", "999.1.1.1"), ("product", "cordcam"), ("country", "FIN"), ("titleRu", "Хель синки"), ("titleEn", 'He"lsinki'), ("maxRooms", 0), ("ssh", "root@evil.test"), ("sshKey", "relative/key"), ("rtc", "hel.cordcam.ru")):
            with self.assertRaises(Problem, msg=key):
                catalog.node_add_args({**base, key: value})

    def test_shell_words_quotes_for_display_only(self):
        self.assertEqual(catalog.shell_words(["echo", "a b", "$x"]), "echo 'a b' '$x'")


if __name__ == "__main__":
    unittest.main()
