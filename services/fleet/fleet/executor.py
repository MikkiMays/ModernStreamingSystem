"""Задачи и исполнители (Р-116, Р-117).

`Jobs` создаёт задачу, держит одну на машину и гонит её через исполнитель: `DryRunExecutor` печатает план и
никуда не подключается (по умолчанию); `SshExecutor` выполняет шаги по SSH и включается только явно
(`FLEET_EXECUTOR=ssh` + машина в `FLEET_SSH_MACHINES`); `FakeExecutor` — для тестов. Вывод — построчно в
`job_lines`, отмена — SIGINT процессу (у `deploy.sh` на него стоит `trap`, снимающий обслуживание).
"""

from __future__ import annotations

import asyncio
import secrets
import shlex
import time
from typing import Any, Awaitable, Callable, Protocol

from . import catalog
from .errors import EXECUTOR_DISABLED, JOB_NOT_RUNNING, MACHINE_BUSY, NOT_FOUND, Problem
from .machines import Machine
from .settings import Settings
from .store import Job, Store

Emit = Callable[[str, str], None]


class Executor(Protocol):
    name: str

    async def run(self, machine: Machine, steps: list[list[str]], emit: Emit, timeout: int) -> int: ...


class DryRunExecutor:
    name = "dry-run"

    async def run(self, machine: Machine, steps: list[list[str]], emit: Emit, timeout: int) -> int:
        emit("info", "СУХОЙ ПРОГОН: команды не выполняются, подключения к машине нет.")
        where = f"{machine.ssh or machine.host}:{machine.install_dir}" if machine.install_dir else machine.host
        emit("info", f"Машина {machine.id} ({where}), потолок {timeout // 60} мин")
        for n, step in enumerate(steps, 1):
            emit("plan", f"{n}. $ {catalog.shell_words(step)}")
        return 0


class FakeExecutor:
    """Сценарий для тестов: по шагу — строки вывода и код выхода; первый ненулевой код останавливает."""

    name = "fake"

    def __init__(self, script: list[tuple[list[str], int]] | None = None, delay: float = 0.0) -> None:
        self.script = script or []
        self.delay = delay
        self.calls: list[tuple[str, list[list[str]]]] = []

    async def run(self, machine: Machine, steps: list[list[str]], emit: Emit, timeout: int) -> int:
        self.calls.append((machine.id, steps))
        for n, step in enumerate(steps):
            lines, code = self.script[n] if n < len(self.script) else ([f"ok {step[0]}"], 0)
            emit("cmd", f"$ {catalog.shell_words(step)}")
            for line in lines:
                if self.delay:
                    await asyncio.sleep(self.delay)
                emit("out", line)
            if code:
                return code
        return 0


class SshExecutor:
    name = "ssh"

    def __init__(self, ssh_binary: str = "ssh", known_hosts: str | None = None) -> None:
        self.ssh = ssh_binary
        # У пользователя 10001 в контейнере нет домашнего каталога — известные хосты живут в томе данных.
        self.known_hosts = known_hosts

    def command(self, machine: Machine, step: list[str]) -> list[str]:
        if not machine.ssh:
            raise Problem(409, EXECUTOR_DISABLED, f"У машины {machine.id} не задан адрес SSH")
        remote = " && ".join(
            part for part in (f"cd {shlex.quote(machine.install_dir)}" if machine.install_dir else "", catalog.shell_words(step)) if part
        )
        argv = [self.ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=accept-new"]
        if self.known_hosts:
            argv += ["-o", f"UserKnownHostsFile={self.known_hosts}"]
        if machine.ssh_key:
            argv += ["-i", machine.ssh_key]
        return argv + [machine.ssh, "--", remote]

    async def run(self, machine: Machine, steps: list[list[str]], emit: Emit, timeout: int) -> int:
        deadline = time.monotonic() + timeout
        for step in steps:
            argv = self.command(machine, step)
            emit("cmd", f"$ {catalog.shell_words(step)}")
            process = await asyncio.create_subprocess_exec(
                *argv, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
            )
            try:
                await asyncio.wait_for(
                    asyncio.gather(_pump(process.stdout, "out", emit), _pump(process.stderr, "err", emit), process.wait()),
                    timeout=max(1.0, deadline - time.monotonic()),
                )
            except asyncio.TimeoutError:
                emit("err", f"Потолок {timeout} с исчерпан — шаг прерван")
                await _interrupt(process)
                return 124
            except asyncio.CancelledError:
                emit("err", "Отменено — процессу послан SIGINT")
                await _interrupt(process)
                raise
            code = process.returncode or 0
            if code:
                emit("err", f"Код выхода {code}")
                return code
        return 0


async def _pump(stream: asyncio.StreamReader | None, name: str, emit: Emit) -> None:
    if stream is None:
        return
    while True:
        line = await stream.readline()
        if not line:
            return
        emit(name, line.decode("utf-8", "replace").rstrip("\n"))


async def _interrupt(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        process.send_signal(2)
        await asyncio.wait_for(process.wait(), timeout=10)
    except (asyncio.TimeoutError, ProcessLookupError):
        try:
            process.kill()
        except ProcessLookupError:
            pass


class Jobs:
    def __init__(
        self,
        store: Store,
        settings: Settings,
        live: Executor | None = None,
        dry: Executor | None = None,
        on_finish: Callable[[Job], Awaitable[None]] | None = None,
    ) -> None:
        self.store = store
        self.settings = settings
        self.live = live or SshExecutor()
        self.dry = dry or DryRunExecutor()
        self.on_finish = on_finish
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.store.abandon_running_jobs()

    def executor_for(self, machine: Machine, dry_run: bool) -> Executor:
        if dry_run:
            return self.dry
        if not self.settings.ssh_allowed(machine.id):
            raise Problem(
                409,
                EXECUTOR_DISABLED,
                f"Исполнитель для {machine.id} выключен: включите FLEET_EXECUTOR=ssh и добавьте машину в FLEET_SSH_MACHINES — "
                "до этого доступен только сухой прогон",
            )
        return self.live

    def start(self, kind: str, machine: Machine, args: dict[str, Any], actor: str, dry_run: bool) -> Job:
        operation = catalog.operation(kind)
        steps = operation.build(machine, args)  # проверка аргументов — до записи задачи
        executor = self.executor_for(machine, dry_run)
        if self.store.running_job(machine.id):
            raise Problem(409, MACHINE_BUSY, f"На машине {machine.id} уже идёт задача — дождитесь её конца")
        job = Job(
            id=secrets.token_hex(6),
            kind=kind,
            machine=machine.id,
            args=args,
            actor=actor,
            dry_run=dry_run,
            status="queued",
            created_at=int(time.time()),
        )
        self.store.create_job(job)
        self.tasks[job.id] = asyncio.get_running_loop().create_task(self._run(job, machine, steps, executor, operation.timeout))
        return job

    async def _run(self, job: Job, machine: Machine, steps: list[list[str]], executor: Executor, timeout: int) -> None:
        job.status = "running"
        job.started_at = int(time.time())
        self.store.update_job(job)
        emit: Emit = lambda stream, text: self.store.add_line(job.id, stream, text)
        try:
            code = await executor.run(machine, steps, emit, timeout)
            job.exit_code = code
            job.status = "ok" if code == 0 else "failed"
            job.summary = "Сухой прогон: план показан" if job.dry_run else ("Выполнено" if code == 0 else f"Код выхода {code}")
        except asyncio.CancelledError:
            job.status = "cancelled"
            job.summary = "Отменена"
        except Problem as error:
            job.status = "failed"
            job.summary = error.detail
            emit("err", error.detail)
        except Exception as error:  # noqa: BLE001 — любая ошибка исполнителя — исход задачи, не падение службы
            job.status = "failed"
            job.summary = f"{error.__class__.__name__}: {error}"
            emit("err", job.summary)
        finally:
            job.finished_at = int(time.time())
            self.store.update_job(job)
            self.tasks.pop(job.id, None)
            if self.on_finish:
                await self.on_finish(job)

    def cancel(self, id: str) -> Job:
        job = self.store.job(id)
        if not job:
            raise Problem(404, NOT_FOUND, "Такой задачи нет")
        task = self.tasks.get(id)
        if not task or job.status not in ("queued", "running"):
            raise Problem(409, JOB_NOT_RUNNING, "Задача уже завершилась")
        task.cancel()
        return job

    async def wait(self, id: str, timeout: float = 30) -> Job | None:
        task = self.tasks.get(id)
        if task:
            await asyncio.wait({task}, timeout=timeout)
        return self.store.job(id)
