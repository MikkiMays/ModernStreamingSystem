package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Куратор (`cord-publisher --probe`): синтетический звонок через SFU раз в минуту (R10, R68).
//
// ЗАЧЕМ. Когда у людей «звук глючит», неизвестно, кто виноват: хост (steal, замирания), сеть до
// сервера или наш код. Куратор — как у Discord (docs/research §2.1): два участника на самой
// машине входят в служебную комнату `cord-probe`, один публикует тон 1 кГц десять секунд, второй
// его слушает, и по пути туда и обратно через SFU считаются потери, джиттер и оборот. Сети между
// ними нет — только SFU и хост. Потери здесь — потери хоста; у людей они будут не меньше.
//
// Комната служебная и ядру неизвестна: вебхуки по ней ядро пропускает (`InternalController`),
// в «Активности» и `cord_rooms_active` её нет; в `livekit_room_total` — есть (минуту после пробы,
// `empty_timeout`). Токены куратор подписывает сам ключом SFU из `.env` — ядро для замера не нужно
// и мерить можно, даже когда оно лежит.
//
// Метрики — Prometheus на `--listen` (127.0.0.1:9402): `cord_probe_loss_ratio{leg}`,
// `cord_probe_jitter_ms{leg}`, `cord_probe_rtt_ms`, `cord_probe_runs_total{result}`,
// `cord_probe_last_success_timestamp_seconds`. `leg="up"` — путь издатель → SFU (из RTCP-отчётов
// SFU), `leg="down"` — SFU → слушатель (по номерам пакетов у слушателя).

const (
	probeIdentityPublisher  = "cord-probe-pub"
	probeIdentitySubscriber = "cord-probe-sub"
	// Сколько ждать после последнего кадра, чтобы долетело всё, что в пути.
	probeSettle = 1500 * time.Millisecond
	// Столько проба ждёт входа в комнату и подписки.
	probeConnect = 15 * time.Second
)

type probeMetrics struct {
	loss        *prometheus.GaugeVec
	jitter      *prometheus.GaugeVec
	rtt         prometheus.Gauge
	packets     *prometheus.GaugeVec
	runs        *prometheus.CounterVec
	lastSuccess prometheus.Gauge
	duration    prometheus.Gauge
}

func newProbeMetrics(registry prometheus.Registerer) *probeMetrics {
	m := &probeMetrics{
		loss: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "cord_probe_loss_ratio",
			Help: "Доля потерянных пакетов пробы через SFU: up — издатель→SFU, down — SFU→слушатель.",
		}, []string{"leg"}),
		jitter: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "cord_probe_jitter_ms",
			Help: "Джиттер прихода пакетов пробы (RFC 3550), мс.",
		}, []string{"leg"}),
		rtt: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "cord_probe_rtt_ms",
			Help: "Оборот издатель↔SFU по RTCP, мс.",
		}),
		packets: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "cord_probe_packets",
			Help: "Пакетов за пробу: sent — отправлено издателем, received — получено слушателем.",
		}, []string{"leg"}),
		runs: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cord_probe_runs_total",
			Help: "Пробы по исходу: ok — замер есть, error — не вошли/не подписались/не долетело.",
		}, []string{"result"}),
		lastSuccess: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "cord_probe_last_success_timestamp_seconds",
			Help: "Когда последняя проба удалась (unix time).",
		}),
		duration: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "cord_probe_run_seconds",
			Help: "Сколько заняла последняя проба целиком: вход, тон, выход.",
		}),
	}
	registry.MustRegister(m.loss, m.jitter, m.rtt, m.packets, m.runs, m.lastSuccess, m.duration)
	// Чтобы ряды были с первого сбора, а не после первой удачи.
	m.runs.WithLabelValues("ok")
	m.runs.WithLabelValues("error")
	return m
}

// probeResult — что намерила одна проба.
type probeResult struct {
	sent, received int
	lossDown       float64
	lossUp         float64
	jitterDownMs   float64
	jitterUpMs     float64
	rttMs          float64
	rttKnown       bool
}

func (m *probeMetrics) record(result probeResult, took time.Duration) {
	m.loss.WithLabelValues("down").Set(result.lossDown)
	m.loss.WithLabelValues("up").Set(result.lossUp)
	m.jitter.WithLabelValues("down").Set(result.jitterDownMs)
	m.jitter.WithLabelValues("up").Set(result.jitterUpMs)
	if result.rttKnown {
		m.rtt.Set(result.rttMs)
	}
	m.packets.WithLabelValues("sent").Set(float64(result.sent))
	m.packets.WithLabelValues("received").Set(float64(result.received))
	m.runs.WithLabelValues("ok").Inc()
	m.lastSuccess.SetToCurrentTime()
	m.duration.Set(took.Seconds())
}

// --- счёт -----------------------------------------------------------------------------------

// receiveStats считает приём по номерам и меткам пакетов RTP: потери — по дырам в номерах с учётом
// переполнения 16 бит, джиттер — межпакетный по RFC 3550 (J += (|D| − J) / 16) в тактах 48 кГц.
type receiveStats struct {
	mu        sync.Mutex
	count     int
	first     bool
	base      uint32 // расширенный номер первого пакета
	highest   uint32 // расширенный номер старшего
	cycles    uint32
	lastSeq   uint16
	jitter    float64
	transit   int64
	transited bool
}

func (s *receiveStats) add(seq uint16, timestamp uint32, arrival time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.count++
	if !s.first {
		s.first = true
		s.base = uint32(seq)
		s.highest = uint32(seq)
		s.lastSeq = seq
	} else {
		// Переполнение: номер прыгнул с конца диапазона в начало.
		if seq < s.lastSeq && s.lastSeq-seq > 0x8000 {
			s.cycles += 0x10000
		}
		if extended := s.cycles + uint32(seq); extended > s.highest {
			s.highest = extended
		}
		s.lastSeq = seq
	}
	// Время прихода в тактах кодека минус метка: разница двух таких «транзитов» и есть D.
	transit := arrival.UnixNano()*48/1_000_000 - int64(timestamp)
	if s.transited {
		d := transit - s.transit
		if d < 0 {
			d = -d
		}
		s.jitter += (float64(d) - s.jitter) / 16
	}
	s.transit = transit
	s.transited = true
}

// expected — сколько пакетов должно было прийти по номерам.
func (s *receiveStats) expected() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.first {
		return 0
	}
	return int(s.highest-s.base) + 1
}

func (s *receiveStats) received() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.count
}

// jitterMs — накопленный джиттер в миллисекундах.
func (s *receiveStats) jitterMs() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.jitter / 48
}

// lossRatio — доля потерь: ожидалось `expected`, пришло `received`; дубликаты потери не отменяют.
func lossRatio(expected, received int) float64 {
	if expected <= 0 || received >= expected {
		return 0
	}
	return float64(expected-received) / float64(expected)
}

// ntpCompact — середина 64-битной метки NTP (16 бит секунд и 16 бит долей), как в LSR/DLSR.
func ntpCompact(t time.Time) uint32 {
	seconds := uint64(t.Unix()) + 2208988800
	fraction := (uint64(t.Nanosecond()) << 32) / 1_000_000_000
	return uint32(seconds<<16) | uint32(fraction>>16)
}

// rttFromReport — оборот по отчёту приёмника: сейчас минус наш SR (LSR) минус задержка у них (DLSR),
// всё в долях 1/65536 с. Нет LSR — отчёт пришёл до нашего первого SR, оборота по нему нет.
func rttFromReport(now time.Time, lsr, dlsr uint32) (time.Duration, bool) {
	if lsr == 0 {
		return 0, false
	}
	units := ntpCompact(now) - lsr - dlsr
	if units > 1<<31 {
		// Отрицательное после переполнения: часы разошлись, доверять нечему.
		return 0, false
	}
	return time.Duration(float64(units) / 65536 * float64(time.Second)), true
}

// upstream — что SFU говорит об отправке издателя в своих RTCP-отчётах.
type upstream struct {
	mu        sync.Mutex
	lost      uint32
	jitter    uint32
	rttMs     float64
	rttKnown  bool
	expected  int
	lastSeqOK bool
	baseSeq   uint32
	highest   uint32
}

func (u *upstream) report(now time.Time, r rtcp.ReceptionReport) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.lost = r.TotalLost
	u.jitter = r.Jitter
	if !u.lastSeqOK {
		u.lastSeqOK = true
		u.baseSeq = r.LastSequenceNumber
	}
	u.highest = r.LastSequenceNumber
	if rtt, ok := rttFromReport(now, r.LastSenderReport, r.Delay); ok {
		u.rttMs = float64(rtt) / float64(time.Millisecond)
		u.rttKnown = true
	}
}

// --- тон ------------------------------------------------------------------------------------

// tone — десять секунд синуса 1 кГц в Opus, кадрами по 20 мс, ещё до входа в комнату: кодирование
// не должно мешать замеру, а ffmpeg в образе уже есть (им же кодируется музыка).
func tone(seconds int) ([][]byte, error) {
	cmd := exec.Command("ffmpeg",
		"-nostdin", "-v", "error", "-threads", "1",
		"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=1000:sample_rate=48000:duration=%d", seconds),
		"-af", "volume=-12dB",
		"-ac", "2", "-ar", "48000",
		"-c:a", "libopus", "-b:a", "64k", "-vbr", "constrained",
		"-application", "audio", "-frame_duration", "20",
		"-f", "ogg", "-page_duration", "20000", "pipe:1",
	)
	cmd.Stderr = os.Stderr
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var frames [][]byte
	stream := newOggStream(pipe)
	for {
		packets, err := stream.next()
		if err != nil {
			break
		}
		for _, packet := range packets {
			if len(packet) >= 8 && (string(packet[:8]) == "OpusHead" || string(packet[:8]) == "OpusTags") {
				continue
			}
			frames = append(frames, packet)
		}
	}
	if err := cmd.Wait(); err != nil {
		return nil, fmt.Errorf("ffmpeg: %w", err)
	}
	if len(frames) == 0 {
		return nil, errors.New("ffmpeg не отдал ни одного кадра")
	}
	return frames, nil
}

// --- одна проба -----------------------------------------------------------------------------

type probeConfig struct {
	url, key, secret, room string
	seconds                int
}

func probeToken(cfg probeConfig, identity string, publish bool) (string, error) {
	grant := &auth.VideoGrant{RoomJoin: true, Room: cfg.room}
	grant.SetCanPublish(publish)
	grant.SetCanSubscribe(!publish)
	grant.SetCanPublishData(false)
	return auth.NewAccessToken(cfg.key, cfg.secret).
		SetIdentity(identity).
		SetName(identity).
		SetValidFor(5 * time.Minute).
		SetVideoGrant(grant).
		ToJWT()
}

func probeOnce(cfg probeConfig, frames [][]byte) (probeResult, error) {
	var result probeResult
	down := &receiveStats{}
	subscribed := make(chan struct{}, 1)
	subToken, err := probeToken(cfg, probeIdentitySubscriber, false)
	if err != nil {
		return result, err
	}
	pubToken, err := probeToken(cfg, probeIdentityPublisher, true)
	if err != nil {
		return result, err
	}
	listener, err := lksdk.ConnectToRoomWithToken(cfg.url, subToken, &lksdk.RoomCallback{
		ParticipantCallback: lksdk.ParticipantCallback{
			OnTrackSubscribed: func(track *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
				select {
				case subscribed <- struct{}{}:
				default:
				}
				go func() {
					for {
						packet, _, err := track.ReadRTP()
						if err != nil {
							return
						}
						down.add(packet.SequenceNumber, packet.Timestamp, time.Now())
					}
				}()
			},
		},
	}, lksdk.WithAutoSubscribe(true), lksdk.WithConnectTimeout(probeConnect))
	if err != nil {
		return result, fmt.Errorf("слушатель не вошёл: %w", err)
	}
	defer listener.Disconnect()

	up := &upstream{}
	speaker, err := lksdk.ConnectToRoomWithToken(cfg.url, pubToken, &lksdk.RoomCallback{},
		lksdk.WithAutoSubscribe(false), lksdk.WithConnectTimeout(probeConnect))
	if err != nil {
		return result, fmt.Errorf("издатель не вошёл: %w", err)
	}
	defer speaker.Disconnect()
	track, err := lksdk.NewLocalTrack(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		lksdk.WithRTCPHandler(func(packet rtcp.Packet) {
			if report, ok := packet.(*rtcp.ReceiverReport); ok {
				now := time.Now()
				for _, r := range report.Reports {
					up.report(now, r)
				}
			}
		}),
	)
	if err != nil {
		return result, err
	}
	if _, err := speaker.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name: "probe", Source: livekit.TrackSource_MICROPHONE, DisableDTX: true, Stereo: true,
	}); err != nil {
		return result, fmt.Errorf("дорожка не опубликована: %w", err)
	}
	select {
	case <-subscribed:
	case <-time.After(probeConnect):
		return result, errors.New("слушатель не подписался на дорожку пробы")
	}
	started := time.Now()
	for i, data := range frames {
		deadline := started.Add(time.Duration(i) * frame)
		if wait := time.Until(deadline); wait > 0 {
			time.Sleep(wait)
		}
		if err := track.WriteSample(media.Sample{Data: data, Duration: frame, Timestamp: deadline}, nil); err != nil {
			return result, fmt.Errorf("кадр не ушёл: %w", err)
		}
		result.sent++
	}
	time.Sleep(probeSettle)
	result.received = down.received()
	if result.received == 0 {
		return result, errors.New("до слушателя не дошло ни одного пакета")
	}
	result.lossDown = lossRatio(down.expected(), result.received)
	result.jitterDownMs = down.jitterMs()
	up.mu.Lock()
	result.lossUp = lossRatio(result.sent, result.sent-int(min(uint32(result.sent), up.lost)))
	result.jitterUpMs = float64(up.jitter) / 48
	result.rttMs, result.rttKnown = up.rttMs, up.rttKnown
	up.mu.Unlock()
	return result, nil
}

// --- цикл -----------------------------------------------------------------------------------

func runProbe(args []string) int {
	flags := flag.NewFlagSet("probe", flag.ContinueOnError)
	room := flags.String("room", "cord-probe", "служебная комната SFU")
	every := flags.Duration("every", time.Minute, "как часто мерить")
	seconds := flags.Int("seconds", 10, "сколько секунд тона за пробу")
	listen := flags.String("listen", "127.0.0.1:9402", "адрес /metrics")
	once := flags.Bool("once", false, "одна проба и выход (проверка руками)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	url := strings.Replace(strings.Replace(setting("LIVEKIT_INTERNAL_URL", "http://127.0.0.1:7880"), "http://", "ws://", 1), "https://", "wss://", 1)
	cfg := probeConfig{
		url:     url,
		key:     os.Getenv("LIVEKIT_API_KEY"),
		secret:  os.Getenv("LIVEKIT_API_SECRET"),
		room:    *room,
		seconds: *seconds,
	}
	if cfg.key == "" || cfg.secret == "" {
		log.Print("куратор: нужны LIVEKIT_API_KEY и LIVEKIT_API_SECRET")
		return 2
	}
	registry := prometheus.NewRegistry()
	metrics := newProbeMetrics(registry)
	if !*once {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
		server := &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
		go func() {
			if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("куратор: /metrics не слушает: %v", err)
				os.Exit(1)
			}
		}()
	}
	for {
		began := time.Now()
		frames, err := tone(cfg.seconds)
		var result probeResult
		if err == nil {
			result, err = probeOnce(cfg, frames)
		}
		if err != nil {
			metrics.runs.WithLabelValues("error").Inc()
			log.Printf("куратор: проба не удалась: %v", err)
		} else {
			metrics.record(result, time.Since(began))
			log.Printf("куратор: отправлено %d, получено %d, потери вниз %.2f %%, вверх %.2f %%, джиттер %.1f/%.1f мс, оборот %.0f мс",
				result.sent, result.received, result.lossDown*100, result.lossUp*100,
				result.jitterDownMs, result.jitterUpMs, result.rttMs)
		}
		if *once {
			if err != nil {
				return 1
			}
			return 0
		}
		if wait := *every - time.Since(began); wait > 0 {
			time.Sleep(wait)
		}
	}
}
