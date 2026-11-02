"""Запускает N издателей музыки Cord (cord-publisher) с одним и тем же файлом, держит duration секунд."""
import json, subprocess, sys, time
tokens = json.load(open('/work/tokens.json'))
duration = int(sys.argv[1])
procs = []
for i, t in enumerate(tokens):
    p = subprocess.Popen(['cord-publisher'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    p.stdin.write(json.dumps({'cmd': 'connect', 'url': 'ws://127.0.0.1:7880', 'token': t, 'name': f'music{i}'}) + '\n')
    procs.append(p)
for p in procs:
    line = p.stdout.readline()
    if 'ready' not in line:
        print('not ready:', line, flush=True)
for p in procs:
    p.stdin.write(json.dumps({'cmd': 'play', 'path': '/work/noise.flac', 'position': 0, 'epoch': 1}) + '\n')
print('playing', len(procs), flush=True)
time.sleep(duration)
for p in procs:
    try:
        p.stdin.write(json.dumps({'cmd': 'quit'}) + '\n'); p.stdin.flush()
    except Exception: pass
time.sleep(2)
for p in procs: p.kill()
