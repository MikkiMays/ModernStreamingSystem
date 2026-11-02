# Разбор записи того, что слышит слушатель (R182).
#
# Вход — WAV 48 кГц стерео: слева треугольная развёртка ±750 Гц/с (300…3300 Гц), справа 997 Гц.
# По окнам 40 мс (шаг 20 мс):
#   thdnL — остаток после подгонки линейной развёртки (частота и фаза свободные, скорость ±750 Гц/с), дБ;
#   thdnR — остаток после подгонки синуса 997 Гц, дБ;
#   rate  — темп воспроизведения по траектории частоты развёртки: 1 — как у источника, <1 — NetEq тянет
#           (замедление, preemptive expand), >1 — сжимает (accelerate);
#   echo  — вторая составляющая развёртки после «расчирпления», дБ к основной: копия того же звука с
#           задержкой (двойное воспроизведение) даёт пик на k·d Гц от основного;
#   side  — энергия L−R к L+R, дБ: моно даёт −∞ (каналы одинаковые);
#   rms   — уровень окна, дБFS.
#
# Нужны numpy и scipy (образ служб + `pip install numpy scipy`):
#   python3 -I listener-analysis.py join-ctx1.wav [окна.jsonl]  → сводка по отрезкам после начала звука
import json
import sys

import numpy as np

K = 750.0
F_TONE = 997.0


def read(path):
    from scipy.io import wavfile

    rate, data = wavfile.read(path)
    if data.dtype == np.int16:
        data = data.astype(np.float64) / 32768.0
    else:
        data = data.astype(np.float64)
    if data.ndim == 1:
        data = np.stack([data, data], axis=1)
    return rate, data[:, 0], data[:, 1]


def fit_tone(x, rate, f):
    n = len(x)
    tau = (np.arange(n) - n / 2) / rate
    basis = np.stack([np.cos(2 * np.pi * f * tau), np.sin(2 * np.pi * f * tau), np.ones(n)], axis=1)
    coef, *_ = np.linalg.lstsq(basis, x, rcond=None)
    res = x - basis @ coef
    return res


def chirp_basis(n, rate, f0, k):
    tau = (np.arange(n) - n / 2) / rate
    theta = 2 * np.pi * (f0 * tau + 0.5 * k * tau * tau)
    return np.stack([np.cos(theta), np.sin(theta), np.ones(n)], axis=1)


def fit_chirp(x, rate, win):
    n = len(x)
    tau = (np.arange(n) - n / 2) / rate
    best = None
    pad = 16384
    for k in (K, -K):
        d = x * np.exp(-1j * np.pi * k * tau * tau) * win
        spec = np.abs(np.fft.rfft(d.real, pad)) + 0  # реальная часть достаточно для поиска пика
        # Комплексный спектр нужен для эха: отрицательные частоты — зеркальная составляющая.
        cspec = np.abs(np.fft.fft(d, pad))
        freqs = np.fft.fftfreq(pad, 1 / rate)
        pos = (freqs > 150) & (freqs < 3500)
        i = np.argmax(np.where(pos, cspec, 0))
        f0 = freqs[i]
        # Уточнение частоты: парабола по трём точкам.
        if 0 < i < pad - 1:
            a, b, c = np.log(cspec[i - 1] + 1e-12), np.log(cspec[i] + 1e-12), np.log(cspec[i + 1] + 1e-12)
            p = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
            f0 = freqs[i] + p * (rate / pad)
        # Подгонка с маленьким перебором частоты вокруг пика.
        local = None
        for df in np.linspace(-6, 6, 13):
            basis = chirp_basis(n, rate, f0 + df, k)
            coef, *_ = np.linalg.lstsq(basis, x, rcond=None)
            res = x - basis @ coef
            e = float(np.dot(res, res))
            if local is None or e < local[0]:
                local = (e, f0 + df, res)
        # Эхо: в «расчирпленном» спектре вне главного лепестка (±100 Гц) ищем вторую составляющую.
        main = cspec[i]
        mask = pos & (np.abs(freqs - freqs[i]) > 100)
        echo = float(np.max(np.where(mask, cspec, 0)) / (main + 1e-12))
        cand = (local[0], local[1], k, local[2], echo)
        if best is None or cand[0] < best[0]:
            best = cand
    return best


def db(v):
    return float(10 * np.log10(max(v, 1e-20)))


def analyze(path, start=None):
    rate, L, R = read(path)
    n = int(0.040 * rate)
    hop = int(0.020 * rate)
    win = np.hanning(n)
    rows = []
    for s in range(0, len(L) - n, hop):
        l = L[s : s + n]
        r = R[s : s + n]
        el = float(np.dot(l, l))
        er = float(np.dot(r, r))
        rms = db((el + er) / (2 * n))
        row = {'t': s / rate, 'rms': rms}
        if rms < -40:
            row['silent'] = True
            rows.append(row)
            continue
        e, f0, k, res, echo = fit_chirp(l, rate, win)
        row['f0'] = f0
        row['k'] = k
        row['thdnL'] = db(e / max(el, 1e-20))
        rr = fit_tone(r, rate, F_TONE)
        row['thdnR'] = db(float(np.dot(rr, rr)) / max(er, 1e-20))
        row['echo'] = 20 * np.log10(max(echo, 1e-9))
        side = l - r
        mid = l + r
        row['side'] = db(float(np.dot(side, side)) / max(float(np.dot(mid, mid)), 1e-20))
        rows.append(row)
    # Темп: наклон частоты по соседним окнам одной стороны треугольника, вдали от разворотов.
    for i in range(2, len(rows) - 2):
        a, b = rows[i - 2], rows[i + 2]
        if any(x.get('silent') for x in (a, rows[i], b)):
            continue
        if not (a['k'] == rows[i]['k'] == b['k']):
            continue
        if min(a['f0'], b['f0']) < 450 or max(a['f0'], b['f0']) > 3150:
            continue
        rows[i]['rate'] = (b['f0'] - a['f0']) / ((b['t'] - a['t']) * rows[i]['k'])
    return rate, rows


def summarize(rows, start, segments):
    out = []
    for lo, hi in segments:
        seg = [r for r in rows if lo <= r['t'] - start < hi]
        if not seg:
            continue
        loud = [r for r in seg if not r.get('silent')]
        rates = np.array([r['rate'] for r in loud if 'rate' in r])
        tl = np.array([r['thdnL'] for r in loud])
        tr = np.array([r['thdnR'] for r in loud])
        echo = np.array([r['echo'] for r in loud])
        side = np.array([r['side'] for r in loud])
        item = {
            'from': lo,
            'to': hi,
            'windows': len(seg),
            'silent': len(seg) - len(loud),
        }
        if len(loud):
            item.update(
                {
                    'thdnR_med': round(float(np.median(tr)), 1),
                    'thdnR_p95': round(float(np.percentile(tr, 95)), 1),
                    'thdnR_bad': int(np.sum(tr > -40)),
                    'thdnL_med': round(float(np.median(tl)), 1),
                    'thdnL_p95': round(float(np.percentile(tl, 95)), 1),
                    'thdnL_bad': int(np.sum(tl > -30)),
                    'echo_med': round(float(np.median(echo)), 1),
                    'echo_p95': round(float(np.percentile(echo, 95)), 1),
                    'side_med': round(float(np.median(side)), 1),
                }
            )
        if len(rates):
            item.update(
                {
                    'rate_med': round(float(np.median(rates)), 4),
                    'rate_min': round(float(np.min(rates)), 4),
                    'rate_max': round(float(np.max(rates)), 4),
                    'stretched': round(float(np.mean(np.abs(rates - 1) > 0.02)), 3),
                }
            )
        out.append(item)
    return out


if __name__ == '__main__':
    path = sys.argv[1]
    rate, rows = analyze(path)
    loud = [r for r in rows if not r.get('silent')]
    start = loud[0]['t'] if loud else 0.0
    segments = [(0, 2), (2, 5), (5, 10), (10, 20), (20, 40), (40, 80), (80, 400)]
    summary = {'file': path, 'audible_at': start, 'duration': rows[-1]['t'] if rows else 0, 'segments': summarize(rows, start, segments)}
    if len(sys.argv) > 2:
        with open(sys.argv[2], 'w') as fh:
            for r in rows:
                fh.write(json.dumps(r) + '\n')
    print(json.dumps(summary, ensure_ascii=False, indent=1))
