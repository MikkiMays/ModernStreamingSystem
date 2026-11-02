#!/usr/bin/env python3
"""Запустить команду и снять CPU/память контейнеров по cgroup каждые 2 с.

usage: cgrun.py NAME --warmup S c1,c2,... -- cmd...
Средние — по окну после warmup до конца. Пишет results/NAME.cg.json.
"""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sfu_run import cg, cpu_usec, mem, host_cpu, OUT

argv = sys.argv[1:]
i = argv.index('--')
name, warm, names = argv[0], int(argv[2]), argv[3].split(',')
cmd = argv[i + 1:]
paths = {n: cg(n) for n in names}
p = subprocess.Popen(cmd)
t0 = time.time()
prev = (time.time(), {n: cpu_usec(c) for n, c in paths.items()}, host_cpu())
samples = []
while p.poll() is None:
    time.sleep(2)
    now = (time.time(), {n: cpu_usec(c) for n, c in paths.items()}, host_cpu())
    dt = now[0] - prev[0]
    hc = [x - y for x, y in zip(now[2], prev[2])]
    tot = sum(hc[:8]) or 1
    s = {'t': round(now[0] - t0, 1), 'host_busy': round(100 * (tot - hc[3] - hc[4]) / tot, 1), 'steal': round(100 * hc[7] / tot, 1)}
    for n in names:
        s[n] = round((now[1][n] - prev[1][n]) / 1e6 / dt, 3)
        s[n + '_mib'] = round(mem(paths[n]) / 2**20)
    samples.append(s)
    prev = now
win = [s for s in samples if s['t'] >= warm] or samples
res = {'name': name}
for k in ['host_busy', 'steal'] + names:
    res[k] = round(sum(s[k] for s in win) / len(win), 3)
for n in names:
    res[n + '_max'] = max(s[n] for s in win)
    res[n + '_mib_max'] = max(s[n + '_mib'] for s in samples)
res['samples'] = samples
json.dump(res, open(os.path.join(OUT, name + '.cg.json'), 'w'), indent=1)
print(json.dumps({k: v for k, v in res.items() if k != 'samples'}))
