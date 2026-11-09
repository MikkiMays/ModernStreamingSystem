#!/usr/bin/env python3
"""Сторож прогона: каждые 2 с ЦП и steal хоста; два замера подряд > 85 % занятости или steal > 30 % — убить тестеры."""
import subprocess, sys, time
LOG = sys.argv[1]
def stat():
    return list(map(int, open('/proc/stat').readline().split()[1:9]))
prev = stat(); bad = 0
with open(LOG, 'a') as log:
    while True:
        time.sleep(2)
        cur = stat(); d = [a - b for a, b in zip(cur, prev)]; prev = cur
        tot = sum(d) or 1
        busy = 100 * (tot - d[3] - d[4]) / tot; steal = 100 * d[7] / tot
        log.write(f"{time.strftime('%H:%M:%S')} busy={busy:.1f} steal={steal:.1f}\n"); log.flush()
        bad = bad + 1 if (busy > 85 or steal > 30) else 0
        if bad >= 2:
            ids = subprocess.run(['docker', 'ps', '-q', '--filter', 'ancestor=livekit/livekit-cli:latest'], capture_output=True, text=True).stdout.split()
            ids += subprocess.run(['docker', 'ps', '-q', '--filter', 'name=lt-bench'], capture_output=True, text=True).stdout.split()
            if ids: subprocess.run(['docker', 'kill', *ids], capture_output=True)
            subprocess.run(['pkill', '-f', 'scratchpad/bin/bench'], capture_output=True); subprocess.run(['pkill', '-f', 'joinlt.mjs|corelt.mjs'], capture_output=True)
            log.write(f"STOP: busy={busy:.1f} steal={steal:.1f}, killed {len(ids)}\n"); log.flush()
            bad = 0
