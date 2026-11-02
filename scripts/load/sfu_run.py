#!/usr/bin/env python3
"""Прогон lk load-test против локального SFU Cord с замером CPU/памяти контейнера SFU по cgroup.

usage: sfu_run.py NAME --duration 60 [--rooms N] [--max-participants M] [--tester-cpus 2] -- <lk load-test args>
Пишет results/NAME.json и results/NAME.log (вывод тестера).
"""
import argparse, base64, hashlib, hmac, json, os, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(ROOT))
ENV = os.environ.get('CORD_ENV', os.path.join(REPO, '.env'))
# Итоги — вне git: .local/load (LOAD_OUT меняет)
OUT = os.environ.get('LOAD_OUT', os.path.join(REPO, '.local', 'load'))
os.makedirs(OUT, exist_ok=True)


def env():
    d = {}
    for line in open(ENV):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            d[k] = v
    return d


E = env()
KEY, SECRET = E['LIVEKIT_API_KEY'], E['LIVEKIT_API_SECRET']


def jwt(grants):
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
    now = int(time.time())
    head = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    body = b64(json.dumps({'iss': KEY, 'nbf': now - 5, 'exp': now + 3600, 'sub': 'loadtest', 'video': grants}).encode())
    sig = b64(hmac.new(SECRET.encode(), f'{head}.{body}'.encode(), hashlib.sha256).digest())
    return f'{head}.{body}.{sig}'


def twirp(method, payload):
    req = urllib.request.Request(
        f'http://127.0.0.1:7880/twirp/livekit.RoomService/{method}',
        data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt({'roomCreate': True, 'roomList': True, 'roomAdmin': True})},
    )
    return json.load(urllib.request.urlopen(req, timeout=10))


def cg(name):
    cid = subprocess.check_output(['docker', 'inspect', '-f', '{{.Id}}', name]).decode().strip()
    return f'/sys/fs/cgroup/system.slice/docker-{cid}.scope'


def cpu_usec(path):
    for line in open(path + '/cpu.stat'):
        if line.startswith('usage_usec'):
            return int(line.split()[1])


def mem(path):
    return int(open(path + '/memory.current').read())


def host_cpu():
    v = list(map(int, open('/proc/stat').readline().split()[1:]))
    # user nice system idle iowait irq softirq steal
    return v


def lo_bytes():
    for line in open('/proc/net/dev'):
        if line.strip().startswith('lo:'):
            f = line.split(':')[1].split()
            return int(f[0]), int(f[8])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('name')
    ap.add_argument('--duration', type=int, default=60)
    ap.add_argument('--warmup', type=int, default=15)
    ap.add_argument('--rooms', type=int, default=1)
    ap.add_argument('--max-participants', type=int, default=0)
    ap.add_argument('--tester-cpus', default='')
    argv = sys.argv[1:]
    i = argv.index('--') if '--' in argv else len(argv)
    a = ap.parse_args(argv[:i])
    lk = argv[i + 1:]
    sfu = cg('modern-streaming-livekit-1')
    rooms = [f'lt-{a.name}-{i}' for i in range(a.rooms)]
    if a.max_participants:
        for r in rooms:
            twirp('CreateRoom', {'name': r, 'max_participants': a.max_participants, 'empty_timeout': 120, 'departure_timeout': 10})
    procs = []
    logs = []
    for r in rooms:
        cmd = ['docker', 'run', '--rm', '--network', 'host']
        if a.tester_cpus:
            cmd += ['--cpus', a.tester_cpus]
        cmd += ['-e', 'LIVEKIT_URL=ws://127.0.0.1:7880', '-e', 'LIVEKIT_API_KEY', '-e', 'LIVEKIT_API_SECRET',
                'livekit/livekit-cli:latest', 'load-test', '--room', r, '--duration', f'{a.duration}s'] + lk
        lf = open(os.path.join(OUT, f'{a.name}-{r}.log'), 'w')
        logs.append(lf)
        procs.append(subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT,
                                      env={**os.environ, 'LIVEKIT_API_KEY': KEY, 'LIVEKIT_API_SECRET': SECRET}))
    samples = []
    t0 = time.time()
    prev = (time.time(), cpu_usec(sfu), host_cpu(), lo_bytes())
    while any(p.poll() is None for p in procs):
        time.sleep(2)
        now = (time.time(), cpu_usec(sfu), host_cpu(), lo_bytes())
        dt = now[0] - prev[0]
        hc = [x - y for x, y in zip(now[2], prev[2])]
        tot = sum(hc[:8]) or 1
        samples.append({
            't': round(now[0] - t0, 1),
            'sfu_cores': round((now[1] - prev[1]) / 1e6 / dt, 3),
            'sfu_mem_mib': round(mem(sfu) / 2**20, 1),
            'host_busy_pct': round(100 * (tot - hc[3] - hc[4]) / tot, 1),
            'host_steal_pct': round(100 * hc[7] / tot, 1),
            'host_softirq_pct': round(100 * hc[6] / tot, 1),
            'lo_mbps': round((now[3][0] - prev[3][0]) * 8 / dt / 1e6, 1),
        })
        prev = now
    for f in logs:
        f.close()
    win = [s for s in samples if a.warmup <= s['t'] <= a.duration - 3] or samples
    avg = lambda k: round(sum(s[k] for s in win) / len(win), 3)
    res = {
        'name': a.name, 'rooms': a.rooms, 'lk': lk, 'duration': a.duration,
        'sfu_cores_avg': avg('sfu_cores'), 'sfu_cores_max': max(s['sfu_cores'] for s in win),
        'sfu_mem_peak_mib': max(s['sfu_mem_mib'] for s in samples),
        'host_busy_avg': avg('host_busy_pct'), 'host_steal_avg': avg('host_steal_pct'),
        'host_softirq_avg': avg('host_softirq_pct'),
        'lo_mbps_avg': avg('lo_mbps'),
        'samples': samples,
    }
    json.dump(res, open(os.path.join(OUT, a.name + '.json'), 'w'), indent=1)
    print(json.dumps({k: v for k, v in res.items() if k != 'samples'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
