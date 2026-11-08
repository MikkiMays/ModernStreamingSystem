"""Отказы пульта — RFC 7807, как у ядра: `{status, code, detail}`."""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse


class Problem(Exception):
    def __init__(self, status: int, code: str, detail: str, **extra: object) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail
        self.extra = extra

    def body(self) -> dict[str, object]:
        return {"status": self.status, "code": self.code, "detail": self.detail, **self.extra}


async def problem_handler(_: Request, error: Exception) -> JSONResponse:
    assert isinstance(error, Problem)
    headers = {"Retry-After": str(error.extra["retryAfter"])} if "retryAfter" in error.extra else None
    return JSONResponse(error.body(), status_code=error.status, headers=headers)


# Коды пульта (не входят в contracts/errors.json: это служба A, а не продукт).
AUTH_REQUIRED = "AUTH_REQUIRED"
AUTH_INVALID = "AUTH_INVALID"
AUTH_LOCKED = "AUTH_LOCKED"
AUTH_DISABLED = "AUTH_DISABLED"
CSRF_REJECTED = "CSRF_REJECTED"
FORBIDDEN = "FORBIDDEN"
NOT_FOUND = "NOT_FOUND"
MACHINE_UNKNOWN = "MACHINE_UNKNOWN"
MACHINE_NO_CORE = "MACHINE_NO_CORE"
MACHINE_BUSY = "MACHINE_BUSY"
CORE_UNREACHABLE = "CORE_UNREACHABLE"
EXECUTOR_DISABLED = "EXECUTOR_DISABLED"
OPERATION_UNKNOWN = "OPERATION_UNKNOWN"
OPERATION_INVALID = "OPERATION_INVALID"
JOB_NOT_RUNNING = "JOB_NOT_RUNNING"
METRICS_UNAVAILABLE = "METRICS_UNAVAILABLE"
