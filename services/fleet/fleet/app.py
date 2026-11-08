"""HTTP пульта: `/api/fleet/*` (§6.5). Служба слушает 127.0.0.1:18200; снаружи — только через шлюз A на
имени `ADMIN_HOST`, который ставит `X-Real-IP` и срезает `X-Fleet-Agent`."""

from __future__ import annotations

import json
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import Depends, FastAPI, Query, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from . import catalog
from .auth import AGENT, OWNER, Actor, Auth
from .core_link import CoreLink
from .errors import AUTH_DISABLED, CSRF_REJECTED, FORBIDDEN, NOT_FOUND, OPERATION_INVALID, Problem, problem_handler
from .executor import Executor, Jobs, SshExecutor
from .machines import Machine, Machines, parse
from .metrics import Metrics
from .settings import SESSION_LIFETIME, Settings, from_env
from .store import Store

log = logging.getLogger("fleet")
PREFIX = "/api/fleet"


class Login(BaseModel):
    password: str = Field(max_length=200)
    code: str = Field(max_length=12)


class JobRequest(BaseModel):
    kind: str = Field(max_length=40)
    machine: str = Field(max_length=16)
    args: dict[str, Any] = Field(default_factory=dict)
    dryRun: bool = True


class Drain(BaseModel):
    on: bool


class MaintenanceNow(BaseModel):
    graceSeconds: int | None = Field(default=None, ge=0, le=3600)
    endsAt: str | None = Field(default=None, max_length=40)
    reason: str | None = Field(default=None, max_length=200)


class MaintenanceSchedule(BaseModel):
    startsAt: str = Field(max_length=40)
    endsAt: str | None = Field(default=None, max_length=40)
    reason: str | None = Field(default=None, max_length=200)


class MaintenanceExtend(BaseModel):
    endsAt: str = Field(max_length=40)


class CloseRoom(BaseModel):
    blockCreator: bool = False
    term: str | None = Field(default=None, max_length=40)


class Block(BaseModel):
    kind: Literal["ip", "profile"] | None = None
    subject: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]*$")
    roomId: str | None = Field(default=None, pattern=r"^[0-9a-f-]{36}$")
    memberId: str | None = Field(default=None, pattern=r"^[0-9a-f-]{36}$")
    term: str | None = Field(default=None, max_length=40)
    reason: str | None = Field(default=None, max_length=200)


class SupportStatus(BaseModel):
    status: str = Field(max_length=20, pattern=r"^[A-Z_]+$")


class NodeAdd(BaseModel):
    form: dict[str, Any]
    dryRun: bool = True


class App:
    """Связка состояния службы: настройки, хранилище, вход, машины, ядра, задачи, метрики."""

    def __init__(
        self,
        settings: Settings,
        store: Store,
        machines: Machines,
        live_executor: Executor | None = None,
        dry_executor: Executor | None = None,
        metrics: Metrics | None = None,
        core_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.settings = settings
        self.store = store
        self.auth = Auth(settings, store)
        self.machines = machines
        self.metrics = metrics or Metrics(settings.metrics_url, settings.alerts_url)
        self.core_client = core_client
        self.cores: dict[str, CoreLink] = {}
        self.jobs: Jobs | None = None
        self._live, self._dry = live_executor, dry_executor

    def start(self) -> None:
        live = self._live or SshExecutor(known_hosts=str(self.settings.data_dir / "known_hosts"))
        self.jobs = Jobs(self.store, self.settings, live, self._dry, on_finish=self._job_finished)
        self.store.audit_prune()

    async def close(self) -> None:
        for link in self.cores.values():
            await link.close()
        await self.metrics.close()

    def core(self, machine_id: str) -> CoreLink:
        machine = self.machines.get(machine_id)
        link = self.cores.get(machine.id)
        if not link:
            link = self.cores[machine.id] = CoreLink(machine, self.core_client)
        return link

    async def _job_finished(self, job) -> None:
        self.store.audit(
            job.actor,
            f"job.{job.kind}",
            "ok" if job.status == "ok" else "failed",
            target=job.machine,
            args=job.args,
            detail=job.summary,
            job_id=job.id,
        )
        if job.kind == "status" and job.status == "ok" and not job.dry_run:
            self.store.save_machine_state(job.machine, {"lines": [line["text"] for line in self.store.lines(job.id)]})


def create_app(state: App | None = None) -> FastAPI:
    if state is None:
        settings = from_env()
        store = Store(settings.data_dir / "fleet.db")
        state = App(settings, store, Machines(parse(settings.machines_source, settings.core_credentials)))

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        state.start()
        try:
            yield
        finally:
            await state.close()

    app = FastAPI(title="Cord fleet", version="1", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.add_exception_handler(Problem, problem_handler)
    app.state.fleet = state
    settings = state.settings

    # ── Вход и доступ ────────────────────────────────────────────────────────────────────────────
    def real_ip(request: Request) -> str | None:
        return request.headers.get("x-real-ip")

    def client_ip(request: Request) -> str:
        return real_ip(request) or (request.client.host if request.client else "127.0.0.1")

    @app.middleware("http")
    async def gate(request: Request, call_next):
        path = request.url.path
        if not path.startswith(PREFIX):
            return PlainTextResponse("", status_code=404)
        if path == PREFIX + "/health":
            return await call_next(request)
        if not settings.enabled:
            return JSONResponse(
                {"status": 404, "code": AUTH_DISABLED, "detail": "Пульт на этом сервере не настроен"}, status_code=404
            )
        ip = real_ip(request)
        if ip is not None and not settings.allows(ip):
            return PlainTextResponse("", status_code=404)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    def actor_of(request: Request) -> Actor | None:
        # R211: сертификат владельца проверен на входе (`edge`), шлюз пульта сказал об этом своим заголовком. Ставит
        # его только блок пульта на своём порту, а пришло через шлюз — значит, есть `X-Real-IP`.
        if (
            settings.edge_cert
            and request.headers.get("x-cord-edge-cert") == "verified"
            and real_ip(request) is not None
        ):
            return Actor(OWNER, None, client_ip(request))
        token = request.cookies.get(settings.cookie_name)
        session = state.auth.session(token)
        if session:
            return Actor(OWNER, session, client_ip(request))
        if state.auth.agent(request.headers.get("x-fleet-agent"), real_ip(request)):
            return Actor(AGENT, None, client_ip(request))
        return None

    def current(request: Request) -> Actor:
        actor = Auth.require(actor_of(request))
        if request.method in ("POST", "PUT", "DELETE", "PATCH") and actor.kind == OWNER:
            if request.headers.get("x-fleet-request") != "1":
                raise Problem(403, CSRF_REJECTED, "Запрос без заголовка пульта отклонён")
            state.auth.check_origin(request.headers.get("origin"), request.headers.get("host"))
        return actor

    def allow(actor: Actor, group: str) -> None:
        if actor.kind == AGENT and not state.auth.agent_may(group):
            raise Problem(403, FORBIDDEN, f"Ключу агента операции группы «{group}» не разрешены")

    def record(actor: Actor, action: str, outcome: str, **fields: Any) -> None:
        state.store.audit(actor.kind, action, outcome, session_id=actor.session_id, ip=actor.ip, **fields)

    def set_cookie(response: Response, token: str) -> None:
        response.set_cookie(
            settings.cookie_name,
            token,
            max_age=SESSION_LIFETIME,
            httponly=True,
            secure=not settings.insecure_dev,
            samesite="strict",
            path="/",
        )

    # ── Служебное ────────────────────────────────────────────────────────────────────────────────
    @app.get(PREFIX + "/health")
    async def health():
        return {"ok": True, "enabled": settings.enabled, "executor": settings.executor, "machines": len(state.machines)}

    @app.post(PREFIX + "/auth/login", status_code=204)
    async def login(body: Login, request: Request, response: Response):
        if request.headers.get("x-fleet-request") != "1":
            raise Problem(403, CSRF_REJECTED, "Запрос без заголовка пульта отклонён")
        state.auth.check_origin(request.headers.get("origin"), request.headers.get("host"))
        token, _ = state.auth.login(body.password, body.code, client_ip(request), request.headers.get("user-agent"))
        set_cookie(response, token)
        response.status_code = 204
        return response

    @app.post(PREFIX + "/auth/logout", status_code=204)
    async def logout(response: Response, actor: Actor = Depends(current)):
        if actor.session:
            state.auth.logout(actor.session)
        response.delete_cookie(settings.cookie_name, path="/")
        response.status_code = 204
        return response

    @app.get(PREFIX + "/auth/me")
    async def me(actor: Actor = Depends(current)):
        session = actor.session
        return {
            "actor": actor.kind,
            "since": session.created_at if session else None,
            "expiresAt": session.created_at + SESSION_LIFETIME if session else None,
            "allowIps": bool(settings.allow_ips),
            "executor": {"mode": settings.executor, "sshMachines": list(settings.ssh_machines)},
            "adminHost": settings.admin_host or None,
            "auth": "edge-cert" if settings.edge_cert else "password",
            "agentOps": list(settings.agent_ops),
        }

    @app.get(PREFIX + "/auth/sessions")
    async def sessions(actor: Actor = Depends(current)):
        allow(actor, "sessions")
        return [
            {
                "id": s.id,
                "ip": s.ip,
                "userAgent": s.user_agent,
                "createdAt": s.created_at,
                "lastSeenAt": s.last_seen_at,
                "current": actor.session is not None and s.id == actor.session.id,
            }
            for s in state.store.sessions()
        ]

    @app.delete(PREFIX + "/auth/sessions", status_code=204)
    async def drop_sessions(response: Response, actor: Actor = Depends(current)):
        if actor.kind != OWNER:
            raise Problem(403, FORBIDDEN, "Сессии гасит только владелец")
        n = state.store.delete_sessions()
        record(actor, "auth.sessions_cleared", "ok", detail=f"{n} сессий")
        response.delete_cookie(settings.cookie_name, path="/")
        response.status_code = 204
        return response

    @app.delete(PREFIX + "/auth/sessions/{id}", status_code=204)
    async def drop_session(id: str, actor: Actor = Depends(current)):
        if actor.kind != OWNER:
            raise Problem(403, FORBIDDEN, "Сессии гасит только владелец")
        if not state.store.delete_session(id):
            raise Problem(404, NOT_FOUND, "Такой сессии нет")
        record(actor, "auth.session_dropped", "ok", target=id)
        return Response(status_code=204)

    # ── Обзор, машины, каталог ───────────────────────────────────────────────────────────────────
    async def safe(coroutine):
        try:
            return {"data": await coroutine, "error": None}
        except Problem as error:
            return {"data": None, "error": error.body()}

    @app.get(PREFIX + "/overview")
    async def overview(actor: Actor = Depends(current)):
        allow(actor, "read")
        machines = []
        for machine in state.machines:
            entry: dict[str, Any] = machine.view()
            entry["metrics"] = await state.metrics.machine(machine)
            saved = state.store.machine_state(machine.id)
            entry["status"] = {"lines": saved[0].get("lines", []), "updatedAt": saved[1]} if saved else None
            if machine.core and machine.core.kind:
                entry["now"] = await safe(state.core(machine.id).get("/api/v1/admin/now"))
                entry["maintenance"] = await safe(state.core(machine.id).get("/api/v1/admin/maintenance/window"))
            else:
                entry["now"] = entry["maintenance"] = None
            machines.append(entry)
        return {
            "serverTime": int(time.time()),
            "machines": machines,
            "alerts": await state.metrics.alerts(),
            "jobs": [j.view() for j in state.store.jobs(limit=10)],
            "executor": {"mode": settings.executor, "sshMachines": list(settings.ssh_machines)},
        }

    @app.get(PREFIX + "/machines")
    async def machines(actor: Actor = Depends(current)):
        allow(actor, "read")
        return state.machines.views()

    @app.get(PREFIX + "/operations")
    async def operations(actor: Actor = Depends(current)):
        return [op.describe() for op in catalog.OPERATIONS.values()]

    # ── Ядро машины: чтение и рычаги ─────────────────────────────────────────────────────────────
    READS = {
        "now": "/api/v1/admin/now",
        "server": "/api/v1/admin/server",
        "blocks": "/api/v1/admin/blocks",
        "support": "/api/v1/admin/support",
        "maintenance": "/api/v1/admin/maintenance/window",
        "drain": "/api/v1/admin/maintenance",
        "meetings": "/api/v1/admin/meetings",
        "quality": "/api/v1/admin/quality",
        "audit": "/api/v1/admin/audit",
        "nodes": "/api/v1/nodes",
    }

    @app.get(PREFIX + "/core/{machine}/{what}")
    async def core_read(machine: str, what: str, request: Request, actor: Actor = Depends(current)):
        allow(actor, "read")
        path = READS.get(what)
        if not path:
            raise Problem(404, NOT_FOUND, f"Ядро не отдаёт «{what}»")
        params = {k: v for k, v in request.query_params.items() if k in ("from", "to", "tz", "group", "code", "outcome", "ip", "room", "cursor", "limit")}
        return await state.core(machine).get(path, params or None)

    async def lever(actor: Actor, machine: str, action: str, call, *, target: str | None = None, args: dict[str, Any] | None = None):
        try:
            result = await call
        except Problem as error:
            record(actor, action, "refused" if error.status < 500 else "failed", target=target or machine, args=args, detail=error.detail)
            raise
        record(actor, action, "ok", target=target or machine, args=args)
        return result if result is not None else Response(status_code=204)

    @app.post(PREFIX + "/core/{machine}/maintenance/now")
    async def maintenance_now(machine: str, body: MaintenanceNow, actor: Actor = Depends(current)):
        allow(actor, "maintenance")
        payload = body.model_dump(exclude_none=True)
        return await lever(actor, machine, "maintenance.now", state.core(machine).post("/api/v1/admin/maintenance/window/now", payload), args=payload)

    @app.post(PREFIX + "/core/{machine}/maintenance/schedule")
    async def maintenance_schedule(machine: str, body: MaintenanceSchedule, actor: Actor = Depends(current)):
        allow(actor, "maintenance")
        payload = body.model_dump(exclude_none=True)
        return await lever(actor, machine, "maintenance.schedule", state.core(machine).post("/api/v1/admin/maintenance/window/schedule", payload), args=payload)

    @app.post(PREFIX + "/core/{machine}/maintenance/extend")
    async def maintenance_extend(machine: str, body: MaintenanceExtend, actor: Actor = Depends(current)):
        allow(actor, "maintenance")
        payload = body.model_dump()
        return await lever(actor, machine, "maintenance.extend", state.core(machine).post("/api/v1/admin/maintenance/window/extend", payload), args=payload)

    @app.delete(PREFIX + "/core/{machine}/maintenance")
    async def maintenance_finish(machine: str, actor: Actor = Depends(current)):
        allow(actor, "maintenance")
        return await lever(actor, machine, "maintenance.finish", state.core(machine).delete("/api/v1/admin/maintenance/window"))

    @app.post(PREFIX + "/core/{machine}/drain")
    async def drain(machine: str, body: Drain, actor: Actor = Depends(current)):
        allow(actor, "drain")
        return await lever(actor, machine, "drain.on" if body.on else "drain.off", state.core(machine).post("/api/v1/admin/maintenance", {"on": body.on}), args={"on": body.on})

    @app.post(PREFIX + "/core/{machine}/rooms/{room}/close")
    async def close_room(machine: str, room: str, body: CloseRoom, actor: Actor = Depends(current)):
        allow(actor, "abuse")
        if len(room) != 36:
            raise Problem(400, NOT_FOUND, "Код встречи — UUID")
        payload = body.model_dump(exclude_none=True)
        return await lever(actor, machine, "room.close", state.core(machine).post(f"/api/v1/admin/rooms/{room}/close", payload), target=f"{machine}:{room}", args=payload)

    @app.post(PREFIX + "/core/{machine}/blocks")
    async def add_block(machine: str, body: Block, actor: Actor = Depends(current)):
        allow(actor, "abuse")
        payload = body.model_dump(exclude_none=True)
        return await lever(actor, machine, "block.add", state.core(machine).post("/api/v1/admin/blocks", payload), args=payload)

    @app.delete(PREFIX + "/core/{machine}/blocks/{id}")
    async def lift_block(machine: str, id: str, actor: Actor = Depends(current)):
        allow(actor, "abuse")
        if len(id) > 64:
            raise Problem(400, NOT_FOUND, "Код блока слишком длинный")
        return await lever(actor, machine, "block.lift", state.core(machine).delete(f"/api/v1/admin/blocks/{id}"), target=f"{machine}:{id}")

    @app.delete(PREFIX + "/core/{machine}/shield")
    async def clear_shield(machine: str, actor: Actor = Depends(current)):
        allow(actor, "abuse")
        return await lever(actor, machine, "shield.clear", state.core(machine).delete("/api/v1/admin/shield"))

    @app.put(PREFIX + "/core/{machine}/support/{id}/status")
    async def support_status(machine: str, id: str, body: SupportStatus, actor: Actor = Depends(current)):
        allow(actor, "support")
        if len(id) > 64:
            raise Problem(400, NOT_FOUND, "Код обращения слишком длинный")
        return await lever(actor, machine, "support.status", state.core(machine).put(f"/api/v1/admin/support/{id}/status", body.model_dump()), target=f"{machine}:{id}", args=body.model_dump())

    # ── Узлы ─────────────────────────────────────────────────────────────────────────────────────
    def read_registry(machine: Machine) -> tuple[dict[str, Any] | None, str | None]:
        if not machine.registry:
            return None, "Реестр этой машины с A напрямую не читается — только через задачу status по SSH"
        try:
            return json.loads(Path(machine.registry).read_text(encoding="utf-8")), None
        except FileNotFoundError:
            return None, f"Файла реестра {machine.registry} нет"
        except (OSError, ValueError) as error:
            return None, f"Реестр не прочитан: {error.__class__.__name__}"

    @app.get(PREFIX + "/nodes/{machine}")
    async def nodes(machine: str, actor: Actor = Depends(current)):
        allow(actor, "read")
        m = state.machines.get(machine)
        registry, error = read_registry(m)
        levels = await safe(state.core(machine).get("/api/v1/nodes")) if m.core and m.core.kind else {"data": None, "error": None}
        return {"registry": registry, "registryError": error, "levels": levels}

    NODE_ACTIONS = {"drain": "node.drain", "undrain": "node.undrain", "check": "node.check", "deploy": "node.deploy", "update": "node.update", "remove": "node.remove", "logs": "node.logs"}

    @app.post(PREFIX + "/nodes/{machine}/add")
    async def node_add(machine: str, body: NodeAdd, actor: Actor = Depends(current)):
        allow(actor, "nodes")
        m = state.machines.get(machine)
        fields = catalog.node_add_args(body.form)
        registry, _ = read_registry(m)
        if registry and any(n.get("id") == fields["id"] for n in registry.get("nodes", [])):
            raise Problem(409, OPERATION_INVALID, f"Узел {fields['id']} уже есть в реестре {machine}")
        steps = catalog.plan("node.add", m, body.form)
        result: dict[str, Any] = {
            "fields": fields,
            "dns": catalog.node_add_dns(fields),
            "plan": [catalog.shell_words(step) for step in steps],
            "installDir": m.install_dir,
            "job": None,
        }
        if not body.dryRun:
            assert state.jobs
            job = state.jobs.start("node.add", m, body.form, actor.kind, False)
            record(actor, "job.start", "ok", target=machine, args={"kind": "node.add", "node": fields["id"]}, job_id=job.id)
            result["job"] = job.view()
        return result

    @app.post(PREFIX + "/nodes/{machine}/{node}/{action}")
    async def node_action(machine: str, node: str, action: str, request: Request, actor: Actor = Depends(current)):
        kind = NODE_ACTIONS.get(action)
        if not kind:
            raise Problem(404, NOT_FOUND, f"Действия «{action}» у узла нет")
        operation = catalog.operation(kind)
        allow(actor, operation.group)
        raw = await request.body()
        body = json.loads(raw) if raw else {}
        if not isinstance(body, dict):
            raise Problem(400, OPERATION_INVALID, "Тело запроса — объект")
        args = {**(body.get("args") or {}), "node": node}
        dry_run = bool(body.get("dryRun", True))
        return start_job(actor, kind, machine, args, dry_run)

    # ── Задачи ───────────────────────────────────────────────────────────────────────────────────
    def start_job(actor: Actor, kind: str, machine_id: str, args: dict[str, Any], dry_run: bool) -> dict[str, Any]:
        assert state.jobs
        machine = state.machines.get(machine_id)
        try:
            job = state.jobs.start(kind, machine, args, actor.kind, dry_run)
        except Problem as error:
            record(actor, "job.start", "refused", target=machine_id, args={"kind": kind, **args}, detail=error.detail)
            raise
        record(actor, "job.start", "ok", target=machine_id, args={"kind": kind, "dryRun": dry_run, **args}, job_id=job.id)
        return job.view()

    @app.post(PREFIX + "/jobs")
    async def create_job(body: JobRequest, actor: Actor = Depends(current)):
        allow(actor, catalog.operation(body.kind).group)
        return start_job(actor, body.kind, body.machine, body.args, body.dryRun)

    @app.get(PREFIX + "/jobs")
    async def list_jobs(
        machine: str | None = Query(default=None, max_length=16),
        kind: str | None = Query(default=None, max_length=40),
        limit: int = Query(default=50, ge=1, le=500),
        actor: Actor = Depends(current),
    ):
        allow(actor, "read")
        return [j.view() for j in state.store.jobs(machine=machine, kind=kind, limit=limit)]

    @app.get(PREFIX + "/jobs/{id}")
    async def job(id: str, after: int = Query(default=0, ge=0), actor: Actor = Depends(current)):
        allow(actor, "read")
        found = state.store.job(id)
        if not found:
            raise Problem(404, NOT_FOUND, "Такой задачи нет")
        return {"job": found.view(), "lines": state.store.lines(id, after)}

    @app.post(PREFIX + "/jobs/{id}/cancel", status_code=204)
    async def cancel_job(id: str, actor: Actor = Depends(current)):
        assert state.jobs
        job = state.jobs.cancel(id)
        record(actor, "job.cancel", "ok", target=job.machine, job_id=id)
        return Response(status_code=204)

    # ── Метрики и журнал ─────────────────────────────────────────────────────────────────────────
    @app.get(PREFIX + "/metrics/machines")
    async def metrics_machines(actor: Actor = Depends(current)):
        allow(actor, "read")
        return {m.id: await state.metrics.machine(m) for m in state.machines}

    @app.get(PREFIX + "/metrics/alerts")
    async def metrics_alerts(actor: Actor = Depends(current)):
        allow(actor, "read")
        return await state.metrics.alerts()

    @app.get(PREFIX + "/audit")
    async def audit(
        since: int | None = Query(default=None, alias="from"),
        until: int | None = Query(default=None, alias="to"),
        actor_filter: str | None = Query(default=None, alias="actor", max_length=10),
        action: str | None = Query(default=None, max_length=40),
        outcome: str | None = Query(default=None, max_length=10),
        cursor: int | None = Query(default=None),
        limit: int = Query(default=100, ge=1, le=1000),
        actor: Actor = Depends(current),
    ):
        allow(actor, "read")
        return state.store.audit_query(since=since, until=until, actor=actor_filter, action=action, outcome=outcome, cursor=cursor, limit=limit)

    @app.get(PREFIX + "/audit/export")
    async def audit_export(
        since: int | None = Query(default=None, alias="from"),
        until: int | None = Query(default=None, alias="to"),
        actor: Actor = Depends(current),
    ):
        allow(actor, "read")
        rows = state.store.audit_query(since=since, until=until, limit=1000)
        record(actor, "audit.export", "ok", detail=f"{len(rows)} строк")
        body = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in reversed(rows))
        return PlainTextResponse(body, media_type="application/x-ndjson", headers={"Content-Disposition": "attachment; filename=fleet-audit.jsonl"})

    return app


def main() -> None:  # pragma: no cover — запуск контейнера
    import uvicorn

    host, _, port = os.environ.get("FLEET_LISTEN", "127.0.0.1:18200").rpartition(":")
    uvicorn.run(create_app(), host=host or "127.0.0.1", port=int(port), log_level="warning", access_log=False)


if __name__ == "__main__":  # pragma: no cover
    main()
