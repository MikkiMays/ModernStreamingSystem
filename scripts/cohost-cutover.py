#!/usr/bin/env python3
"""Move the shared TLS listener only after DNS and internal service checks pass.

Default is read-only. --apply changes just the legacy Caddy port publication,
starts the Cord edge and rolls that publication back if public TLS checks fail.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
LEGACY = Path('/opt/kiki/infra')
OLD_PORT = '      - "443:443"'
NEW_PORT = '      - "127.0.0.1:8443:443"'


def run(*args, cwd=ROOT, timeout=120):
    return subprocess.run(args, cwd=cwd, check=True, text=True, capture_output=True, timeout=timeout).stdout


def status(host, path, port=443):
    return int(run('curl', '--silent', '--show-error', '--max-time', '8',
                   '--connect-to', f'{host}:443:127.0.0.1:{port}',
                   '--output', '/dev/null', '--write-out', '%{http_code}',
                   f'https://{host}{path}', timeout=10))


def tls(host):
    with socket.create_connection(('127.0.0.1', 443), timeout=5) as connection:
        with ssl.create_default_context().wrap_socket(connection, server_hostname=host) as secure:
            return secure.version()


def rewrite(text):
    if text.count(OLD_PORT) != 1:
        raise RuntimeError('Expected exactly one original TCP 443 publication; inspect legacy Compose manually')
    return text.replace(OLD_PORT, NEW_PORT)


def save_atomic(path, content):
    temporary = path.with_suffix(path.suffix + '.cord-tmp')
    temporary.write_text(content)
    temporary.chmod(path.stat().st_mode & 0o777)
    temporary.replace(path)


def preflight():
    env = dict(line.split('=', 1) for line in (ROOT / '.env').read_text().splitlines()
               if '=' in line and not line.startswith('#'))
    hosts = [env[key] for key in ('APP_HOST', 'RTC_HOST', 'TURN_HOST')]
    if hosts != ['meet.nikg.tech', 'rtc.nikg.tech', 'turn.nikg.tech']:
        raise RuntimeError('This cutover is scoped to meet/rtc/turn.nikg.tech')
    for host in hosts:
        addresses = {entry[4][0] for entry in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
        if addresses != {env['PUBLIC_IP']}:
            raise RuntimeError(f'{host} must resolve only to {env["PUBLIC_IP"]}; found {sorted(addresses)}')
    run('node', 'scripts/smoke.mjs')
    run('docker', 'compose', 'config', '--quiet')
    run('docker', 'compose', 'config', '--quiet', cwd=LEGACY)
    run('docker', 'compose', 'run', '--rm', '--no-deps', 'edge', 'validate', '--config', '/etc/edge.json')
    edge = json.loads((ROOT / 'infra/generated/edge.json').read_text())
    route = edge['apps']['layer4']['servers']['main']['routes'][-1]
    if set(route['match'][0]['tls']['sni']) != {'nikg.tech', 'media.nikg.tech'}:
        raise RuntimeError('Legacy SNI routes differ from the inspected deployment')
    if route['handle'] != [{'handler': 'proxy', 'upstreams': [{'dial': ['127.0.0.1:8443']}]}]:
        raise RuntimeError('Legacy TLS must pass through unchanged to loopback 8443')
    return hosts


LEGACY_PROBES = [('nikg.tech', '/', 200), ('nikg.tech', '/api/tasks', 401),
                 ('nikg.tech', '/internal/test', 403), ('nikg.tech', '/actuator/health', 403),
                 ('media.nikg.tech', '/', 403)]


def verify_legacy(port=443):
    for host, path, expected in LEGACY_PROBES:
        actual = status(host, path, port)
        if actual != expected:
            raise RuntimeError(f'Legacy route {host}{path}: {actual}, expected {expected}')


def verify_public(hosts):
    for host in hosts:
        tls(host)  # Standard public trust and hostname verification; no insecure fallback.
    if status(hosts[0], '/api/v1/capabilities') != 200:
        raise RuntimeError('Public Cord API is unavailable')
    if status(hosts[1], '/rtc') not in (401, 403):
        raise RuntimeError('Public signaling access gate failed')
    verify_legacy()


def apply_cutover(compose, original, hosts, backup):
    # Keep the backup and failed edge logs for inspection; never remove application data.
    backup.mkdir(parents=True, mode=0o700)
    (backup / 'compose.yaml').write_text(original)
    (backup / 'compose.yaml').chmod(0o600)
    changed = rewrite(original)
    if compose.read_text() != original:
        raise RuntimeError('Legacy Compose changed during preflight; refusing to overwrite it')
    save_atomic(compose, changed)
    try:
        run('docker', 'compose', 'config', '--quiet', cwd=LEGACY)
        run('docker', 'compose', 'up', '-d', '--no-deps', 'caddy', cwd=LEGACY)
        verify_legacy(8443)
        run('docker', 'compose', 'up', '-d', '--no-deps', 'edge')
        deadline = time.monotonic() + 150
        while True:
            try:
                verify_public(hosts)
                break
            except (RuntimeError, OSError, subprocess.SubprocessError):
                if time.monotonic() >= deadline:
                    raise
                time.sleep(3)
    except BaseException:
        run('docker', 'compose', 'stop', 'edge')
        if compose.read_text() != changed:
            raise RuntimeError(f'Concurrent legacy edit: restore manually from {backup}')
        save_atomic(compose, original)
        run('docker', 'compose', 'up', '-d', '--no-deps', 'caddy', cwd=LEGACY)
        verify_legacy()
        print(f'Cutover failed; original legacy TLS publication restored. Backup: {backup}', flush=True)
        raise
    print(f'PASS: new public TLS/API and legacy routes. Backup: {backup}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    hosts = preflight()
    compose = LEGACY / 'compose.yaml'
    original = compose.read_text()
    if NEW_PORT in original:
        verify_public(hosts)
        print('Cutover already applied; all TLS/API/legacy checks passed')
        return
    rewrite(original)
    verify_legacy()
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 8443))
    if not args.apply:
        print('Preflight passed. --apply will move only legacy Caddy to loopback 8443 and start the Cord TLS edge.')
        return
    if os.geteuid() != 0:
        raise RuntimeError('Root is required to update the legacy Docker deployment')
    backup = ROOT / '.local/cohost-backups' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    apply_cutover(compose, original, hosts, backup)


if __name__ == '__main__':
    main()
