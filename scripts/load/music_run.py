#!/usr/bin/env python3
"""Замер бота музыки: N издателей (cord-publisher + ffmpeg) в N комнатах, по S слушателей-тестеров в каждой.

usage: music_run.py NAME N S [duration]
Слушатели — тестеры lk без RED: у Chrome слушатель получает RED×2, то есть ≈ втрое больше.
"""
import json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sfu_run as R

name, n, s = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
duration = int(sys.argv[4]) if len(sys.argv) > 4 else 60
work = os.path.join(R.OUT, 'work')
os.makedirs(work, exist_ok=True)
import shutil
shutil.copy(os.path.join(R.ROOT, 'music-drive.py'), os.path.join(work, 'drive.py'))
if not os.path.exists(os.path.join(work, 'noise.flac')):
    # Розовый шум + тон 440 Гц, 4 минуты стерео: Opus тратит на него полный битрейт, как на музыку.
    subprocess.run(['docker', 'run', '--rm', '-v', f'{work}:/work', '--user', '0', '--entrypoint', 'ffmpeg', 'modern-streaming-services',
                    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.3:duration=240', '-f', 'lavfi', '-i',
                    'sine=frequency=440:duration=240', '-filter_complex', '[0][1]amix=inputs=2,aformat=channel_layouts=stereo',
                    '-ar', '48000', '/work/noise.flac'], check=True)
rooms = [f'lt-{name}-{i}' for i in range(n)]
for r in rooms:
    R.twirp('CreateRoom', {'name': r, 'max_participants': 50, 'empty_timeout': 120, 'departure_timeout': 10})


def token(room, ident):
    import base64, hashlib, hmac
    b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b'=').decode()
    now = int(time.time())
    head = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    body = b64(json.dumps({'iss': R.KEY, 'nbf': now - 5, 'exp': now + 3600, 'sub': ident, 'name': ident,
                           'video': {'room': room, 'roomJoin': True, 'canPublish': True, 'canSubscribe': False}}).encode())
    sig = b64(hmac.new(R.SECRET.encode(), f'{head}.{body}'.encode(), hashlib.sha256).digest())
    return f'{head}.{body}.{sig}'


json.dump([token(r, f'bot-{r}') for r in rooms], open(os.path.join(work, 'tokens.json'), 'w'))
music = subprocess.Popen(['docker', 'run', '--rm', '--name', f'lt-music', '--network', 'host', '-v', f'{work}:/work',
                          '--entrypoint', 'python', 'modern-streaming-services', '/work/drive.py', str(duration + 25)],
                         stdout=open(os.path.join(R.OUT, f'{name}-music.log'), 'w'), stderr=subprocess.STDOUT)
time.sleep(8)
mus = R.cg('lt-music')
subs = []
if s:
    for r in rooms:
        subs.append(subprocess.Popen(['docker', 'run', '--rm', '--network', 'host', '-e', 'LIVEKIT_URL=ws://127.0.0.1:7880',
                                      '-e', 'LIVEKIT_API_KEY', '-e', 'LIVEKIT_API_SECRET', 'livekit/livekit-cli:latest',
                                      'load-test', '--room', r, '--duration', f'{duration}s', '--subscribers', str(s)],
                                     stdout=open(os.path.join(R.OUT, f'{name}-{r}.log'), 'w'), stderr=subprocess.STDOUT,
                                     env={**os.environ, 'LIVEKIT_API_KEY': R.KEY, 'LIVEKIT_API_SECRET': R.SECRET}))
sfu = R.cg('modern-streaming-livekit-1')
samples = []
t0 = time.time()
prev = (time.time(), R.cpu_usec(sfu), R.cpu_usec(mus), R.lo_bytes())
while time.time() - t0 < duration:
    time.sleep(2)
    now = (time.time(), R.cpu_usec(sfu), R.cpu_usec(mus), R.lo_bytes())
    dt = now[0] - prev[0]
    samples.append({'t': round(now[0] - t0, 1), 'sfu_cores': round((now[1] - prev[1]) / 1e6 / dt, 3),
                    'music_cores': round((now[2] - prev[2]) / 1e6 / dt, 3),
                    'music_mem_mib': round(R.mem(mus) / 2**20, 1),
                    'lo_mbps': round((now[3][0] - prev[3][0]) * 8 / dt / 1e6, 2)})
    prev = now
for p in subs:
    p.wait()
music.wait()
win = [x for x in samples if 15 <= x['t'] <= duration - 3] or samples
avg = lambda k: round(sum(x[k] for x in win) / len(win), 3)
res = {'name': name, 'bots': n, 'listeners_per_room': s, 'sfu_cores_avg': avg('sfu_cores'),
       'music_cores_avg': avg('music_cores'), 'music_cores_max': max(x['music_cores'] for x in win),
       'music_mem_peak_mib': max(x['music_mem_mib'] for x in samples), 'lo_mbps_avg': avg('lo_mbps'), 'samples': samples}
json.dump(res, open(os.path.join(R.OUT, name + '.json'), 'w'), indent=1)
print(json.dumps({k: v for k, v in res.items() if k != 'samples'}, ensure_ascii=False))
