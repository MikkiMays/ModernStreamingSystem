"""
Сайты тестов плеера страниц: настоящие HTTP-серверы на 127.0.0.1 и 127.0.0.2 внутри контейнера теста.

Страницы — шаблоны из `pages/` (`{{A}}`, `{{B}}` — адреса двух сайтов, `{{C}}` и `{{CPORT}}` — ловушка), поток
— HLS e2e веба (`/opt/fixtures/hls`), плеер — hls.js той же версии, что у веба. Поток отдаётся только со
своей cookie и своим Referer: так видно, что браузер их послал, а плеер страниц их записал.

Ловушка (`Trap`) — порт на 127.0.0.1, куда выход не пускает: она считает каждое принятое соединение и каждую
датаграмму. Ноль у ловушки — это ноль попыток браузера пройти мимо охраняемого выхода.

Запущенный сам (`python sites.py`), модуль — сайт-фикстура e2e веба (`web/e2e/cinema-sniff.spec.ts`): страница
с плеером hls.js в своём контейнере стенда (`cord-dev-pages`), и `/hits` — кто и с чем спрашивал поток.
"""

from __future__ import annotations

import http.server
import json
import os
import secrets
import socket
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

PAGES = Path(__file__).parent / "pages"
FIXTURES = Path(os.environ.get("CORD_SNIFFER_FIXTURES", "/opt/fixtures"))
# Картинка 1×1 для `og:image`.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082"
)
TYPES = {".m3u8": "application/vnd.apple.mpegurl", ".m2ts": "video/mp2t", ".ts": "video/mp2t"}


@dataclass
class Hit:
    path: str
    query: dict[str, list[str]]
    headers: dict[str, str]
    remote: str = ""


class Site:
    """
    Сайт на своём адресе. `cookie` — его сессия: страница ставит её, поток без неё — 403. `strict` — нужен ли
    потоку и Referer этого сайта (у плеера в чужой рамке cookie третьей стороны браузер не шлёт).
    """

    def __init__(self, host: str, *, strict_cookie: bool = True, port: int = 0, origin: str = ""):
        self.host = host
        self.strict_cookie = strict_cookie
        self.cookie = secrets.token_hex(8)
        self.hits: list[Hit] = []
        self.values: dict[str, str] = {}
        handler = type("Handler", (_Handler,), {"site": self})
        self.server = http.server.ThreadingHTTPServer((host, port), handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        # Адрес сайта, как его видит браузер: у сайта в своём контейнере это его адрес в сети стенда.
        self.origin = origin or f"http://{host}:{self.port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, path: str) -> str:
        return self.origin + path

    def seen(self, path: str) -> list[Hit]:
        return [hit for hit in list(self.hits) if hit.path == path]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class Trap:
    """Порт, куда нельзя: считает соединения TCP и датаграммы UDP — на одном и том же номере порта."""

    def __init__(self, host: str = "127.0.0.1"):
        self.tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.tcp.bind((host, 0))
        self.tcp.listen(64)
        self.port = self.tcp.getsockname()[1]
        self.udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.udp.bind((host, self.port))
        self.origin = f"http://{host}:{self.port}"
        self.accepted = 0
        self.datagrams = 0
        threading.Thread(target=self._accept, daemon=True).start()
        threading.Thread(target=self._receive, daemon=True).start()

    def _accept(self) -> None:
        while True:
            try:
                connection, _ = self.tcp.accept()
            except OSError:
                return
            self.accepted += 1
            connection.close()

    def _receive(self) -> None:
        while True:
            try:
                self.udp.recvfrom(4096)
            except OSError:
                return
            self.datagrams += 1

    def close(self) -> None:
        self.tcp.close()
        self.udp.close()


class _Handler(http.server.BaseHTTPRequestHandler):
    site: Site
    protocol_version = "HTTP/1.1"

    def log_message(self, *args) -> None:
        pass

    def do_GET(self) -> None:
        parts = urlsplit(self.path)
        site = self.site
        headers = {k.lower(): v for k, v in self.headers.items()}
        path = parts.path
        if path == "/hits":
            return self._hits()
        site.hits.append(Hit(path, parse_qs(parts.query), headers, self.client_address[0]))
        if path.startswith("/pages/"):
            return self._page(path.removeprefix("/pages/"))
        if path == "/hls.js":
            return self._send(200, (FIXTURES / "hls.light.min.js").read_bytes(), "application/javascript")
        if path == "/poster.png":
            return self._send(200, PNG, "image/png")
        if path == "/api/source":
            if not self._allowed():
                return self._send(403, b"no session", "text/plain")
            body = json.dumps({"src": "/media/master.m3u8?token=t1"}).encode()
            return self._send(200, body, "application/json")
        if path.startswith("/media/"):
            if not self._allowed():
                return self._send(403, b"no session", "text/plain")
            name = path.removeprefix("/media/")
            file = FIXTURES / "hls" / name
            if "/" in name or not file.is_file():
                return self._send(404, b"", "text/plain")
            return self._send(200, file.read_bytes(), TYPES.get(file.suffix, "application/octet-stream"))
        if path == "/film.mp4":
            return self._send(200, (FIXTURES / "hls" / "180p_0.m2ts").read_bytes(), "video/mp4")
        if path == "/go-inside":
            self.send_response(302)
            self.send_header("Location", site.values.get("C", "") + "/steal")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        if path == "/hang.js":
            time.sleep(40)
            return self._send(200, b"", "application/javascript")
        return self._send(404 if path != "/popup" else 200, b"", "text/plain")

    def _hits(self) -> None:
        """Кто спрашивал поток и с чем: адрес, имя браузера, своя ли cookie и свой ли Referer."""
        site = self.site
        found = [
            {
                "path": hit.path,
                "remote": hit.remote,
                "agent": hit.headers.get("user-agent", ""),
                "cookie": f"sid={site.cookie}" in hit.headers.get("cookie", ""),
                "referer": hit.headers.get("referer", "").startswith(site.origin + "/"),
            }
            for hit in list(site.hits)
            if hit.path.startswith(("/media/", "/api/"))
        ]
        self._send(200, json.dumps(found).encode(), "application/json")

    def _allowed(self) -> bool:
        """Поток — только своему плееру: с cookie этого сайта (если она ему нужна) и с его Referer."""
        site = self.site
        referer = self.headers.get("Referer", "")
        cookie = self.headers.get("Cookie", "")
        if not referer.startswith(site.origin + "/"):
            return False
        return not site.strict_cookie or f"sid={site.cookie}" in cookie

    def _page(self, name: str) -> None:
        file = PAGES / name
        if "/" in name or not file.is_file():
            return self._send(404, b"", "text/plain")
        text = file.read_text(encoding="utf-8")
        for key, value in self.site.values.items():
            text = text.replace("{{" + key + "}}", value)
        self._send(200, text.encode(), "text/html; charset=utf-8", cookie=True)

    def _send(self, status: int, body: bytes, kind: str, *, cookie: bool = False) -> None:
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie:
            self.send_header("Set-Cookie", f"sid={self.site.cookie}; Path=/")
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass


def main() -> None:
    """Сайт-фикстура стенда: слушает все адреса контейнера, свой адрес — по имени контейнера."""
    port = int(os.environ.get("CORD_PAGES_PORT", "18765"))
    address = socket.gethostbyname(socket.gethostname())
    site = Site("0.0.0.0", port=port, origin=f"http://{address}:{port}")
    site.values.update({"A": site.origin})
    print(f"pages: {site.origin}", flush=True)
    threading.Event().wait()


if __name__ == "__main__":
    main()
