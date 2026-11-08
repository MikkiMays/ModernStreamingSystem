import asyncio
import unittest

from fleet.errors import Problem
from fleet.executor import DryRunExecutor, FakeExecutor, Jobs, SshExecutor
from fleet.machines import Machine
from fleet.settings import Settings
from fleet.store import Store

MEET = Machine(id="meet", role="product-core", host="108.165.32.23", install_dir="/opt/meet/ModernStreamingSystem", ssh="root@108.165.32.23", ssh_key="/keys/cord_fra")
A = Machine(id="a", role="dev+admin", host="127.0.0.1", install_dir="/opt/ModernStreamingSystem")


def run(coroutine):
    return asyncio.run(coroutine)


class SshCommandTest(unittest.TestCase):
    def test_argv_has_no_shell_and_quotes_remote_part(self):
        argv = SshExecutor().command(MEET, ["backlog/bin/node.sh", "msk", "deploy"])
        self.assertEqual(argv[0], "ssh")
        self.assertIn("BatchMode=yes", argv)
        self.assertEqual(argv[argv.index("-i") + 1], "/keys/cord_fra")
        self.assertEqual(argv[-3:], ["root@108.165.32.23", "--", "cd /opt/meet/ModernStreamingSystem && backlog/bin/node.sh msk deploy"])

    def test_quoting_of_awkward_arguments(self):
        argv = SshExecutor().command(MEET, ["node", "scripts/node-config.mjs", "--title-ru=Хельсинки", "x y"])
        self.assertTrue(argv[-1].endswith("node scripts/node-config.mjs '--title-ru=Хельсинки' 'x y'"))

    def test_known_hosts_file_is_passed_when_configured(self):
        argv = SshExecutor(known_hosts="/data/known_hosts").command(MEET, ["uptime"])
        self.assertIn("UserKnownHostsFile=/data/known_hosts", argv)

    def test_machine_without_ssh_is_refused(self):
        with self.assertRaises(Problem) as caught:
            SshExecutor().command(A, ["uptime"])
        self.assertEqual(caught.exception.code, "EXECUTOR_DISABLED")


class JobsTest(unittest.TestCase):
    def setUp(self):
        self.store = Store(":memory:")

    def jobs(self, settings=None, live=None):
        return Jobs(self.store, settings or Settings(), live=live or FakeExecutor(), dry=DryRunExecutor())

    def test_dry_run_prints_plan_and_touches_nothing(self):
        async def scenario():
            live = FakeExecutor()
            jobs = self.jobs(live=live)
            job = jobs.start("deploy", MEET, {"services": ["core"], "drain": True}, "owner", True)
            done = await jobs.wait(job.id)
            lines = self.store.lines(job.id)
            return done, lines, live.calls

        done, lines, calls = run(scenario())
        self.assertEqual(done.status, "ok")
        self.assertTrue(done.dry_run)
        self.assertEqual(calls, [])
        self.assertEqual(lines[0]["stream"], "info")
        self.assertIn("СУХОЙ ПРОГОН", lines[0]["text"])
        self.assertEqual(lines[-1]["text"], "1. $ backlog/bin/deploy.sh --drain core")

    def test_live_requires_executor_enabled_for_the_machine(self):
        async def scenario():
            jobs = self.jobs()
            with self.assertRaises(Problem) as caught:
                jobs.start("status", MEET, {}, "owner", False)
            self.assertEqual(caught.exception.code, "EXECUTOR_DISABLED")
            allowed = Settings(executor="ssh", ssh_machines=("meet",))
            live = FakeExecutor([(["5b4718f"], 0), (['{"Service":"core"}'], 0), (["up 3 hours"], 0), (["/dev/vda1 47G"], 0)])
            jobs = self.jobs(allowed, live)
            job = jobs.start("status", MEET, {}, "owner", False)
            done = await jobs.wait(job.id)
            return done, live.calls, self.store.lines(job.id)

        done, calls, lines = run(scenario())
        self.assertEqual(done.status, "ok")
        self.assertEqual(done.exit_code, 0)
        self.assertEqual(calls[0][0], "meet")
        self.assertEqual(len(calls[0][1]), 4)
        self.assertEqual([l["text"] for l in lines if l["stream"] == "out"], ["5b4718f", '{"Service":"core"}', "up 3 hours", "/dev/vda1 47G"])

    def test_failed_step_stops_and_marks_failed(self):
        async def scenario():
            jobs = self.jobs(Settings(executor="ssh", ssh_machines=("meet",)), FakeExecutor([(["fatal: bad object"], 128)]))
            job = jobs.start("rollback", MEET, {"commit": "deadbee", "services": ["core"]}, "owner", False)
            return await jobs.wait(job.id)

        done = run(scenario())
        self.assertEqual(done.status, "failed")
        self.assertEqual(done.exit_code, 128)
        self.assertEqual(done.summary, "Код выхода 128")

    def test_one_job_per_machine(self):
        async def scenario():
            jobs = self.jobs(Settings(executor="ssh", ssh_machines=("meet",)), FakeExecutor(delay=0.2))
            first = jobs.start("status", MEET, {}, "owner", False)
            with self.assertRaises(Problem) as caught:
                jobs.start("status", MEET, {}, "owner", True)
            self.assertEqual(caught.exception.code, "MACHINE_BUSY")
            # Другая машина — можно.
            other = jobs.start("status", A, {}, "owner", True)
            await jobs.wait(first.id)
            await jobs.wait(other.id)
            return self.store.job(first.id).status, self.store.job(other.id).status

        self.assertEqual(run(scenario()), ("ok", "ok"))

    def test_cancel_marks_cancelled(self):
        async def scenario():
            jobs = self.jobs(Settings(executor="ssh", ssh_machines=("meet",)), FakeExecutor([(["a"] * 50, 0)], delay=0.05))
            job = jobs.start("status", MEET, {}, "owner", False)
            await asyncio.sleep(0.1)
            jobs.cancel(job.id)
            done = await jobs.wait(job.id)
            with self.assertRaises(Problem) as caught:
                jobs.cancel(job.id)
            return done.status, caught.exception.code

        self.assertEqual(run(scenario()), ("cancelled", "JOB_NOT_RUNNING"))

    def test_bad_arguments_create_no_job(self):
        async def scenario():
            jobs = self.jobs()
            with self.assertRaises(Problem):
                jobs.start("deploy", MEET, {"services": ["core; rm"]}, "owner", True)
            return self.store.jobs()

        self.assertEqual(run(scenario()), [])

    def test_restart_abandons_running_jobs(self):
        async def scenario():
            jobs = self.jobs(Settings(executor="ssh", ssh_machines=("meet",)), FakeExecutor(delay=5))
            job = jobs.start("status", MEET, {}, "owner", False)
            await asyncio.sleep(0.05)
            jobs.tasks[job.id].cancel()
            # Новый экземпляр при старте помечает незавершённое прерванным (как после перезапуска).
            self.store.db.execute("UPDATE jobs SET status = 'running'")
            Jobs(self.store, Settings(), live=FakeExecutor())
            return self.store.job(job.id)

        job = run(scenario())
        self.assertEqual(job.status, "failed")
        self.assertIn("перезапуском", job.summary)


if __name__ == "__main__":
    unittest.main()
