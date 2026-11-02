# Тестовый трек R182: слева — треугольная линейная развёртка 300→3300→300 Гц (по 4 с в каждую
# сторону, фаза непрерывная), справа — ровные 997 Гц. 44,1 кГц стерео, как обычная музыка, чтобы
# заодно работал ресемплер издателя. Пишет WAV (16 бит), FLAC делает ffmpeg снаружи:
#   python3 -I listener-track.py src.wav 44100 600 && ffmpeg -i src.wav -c:a flac track.flac
# Разбор того, что услышал слушатель, — `listener-analysis.py`.
import sys
import numpy as np
import wave

rate = int(sys.argv[2]) if len(sys.argv) > 2 else 44100
seconds = int(sys.argv[3]) if len(sys.argv) > 3 else 600
n = rate * seconds
t = np.arange(n) / rate
period = 8.0
u = np.mod(t, period)
f = np.where(u < 4.0, 300.0 + 750.0 * u, 3300.0 - 750.0 * (u - 4.0))
phase = 2 * np.pi * np.cumsum(f) / rate
left = 0.5 * np.sin(phase)
right = 0.5 * np.sin(2 * np.pi * 997.0 * t)
pcm = np.empty(2 * n, dtype=np.int16)
pcm[0::2] = np.round(left * 32767).astype(np.int16)
pcm[1::2] = np.round(right * 32767).astype(np.int16)
with wave.open(sys.argv[1], 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(rate)
    w.writeframes(pcm.tobytes())
print('wrote', sys.argv[1], seconds, 's at', rate)
