package main

import (
	"math/rand/v2"
	"strconv"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// RED (RFC 2198) для музыки — у издателя, а не у SFU.
//
// ЗАЧЕМ ЗДЕСЬ. `audio.active_red_encoding` в LiveKit 1.13.6 обещает обернуть в RED дорожку
// издателя, который сам RED не шлёт. На нашей схеме это не работает — и не могло: решение «дать ли
// подписчику RED» принимается по `IsRedEnabled(TrackInfo)`, а там первым делом смотрится кодек
// дорожки, который SFU записывает сам, как только пришёл первый пакет (`participant.go`:
// `ti.Codecs[0].MimeType = track.Codec().MimeType`). У дорожки на чистом Opus это `audio/opus`,
// «RED включён» становится ложью, и `WrappedReceiver` RED не добавляет (`mediatrackreceiver.go`:
// `DisableRed: !IsRedEnabled(...) || !ActiveREDEncoding`). Замер 24.10 (MEDIA-DIAGNOSIS §10) это и
// показал: `packetsDiscarded = 0` у слушателя музыки.
//
// Поэтому избыточность делается там же, где её делает браузер: издатель публикует дорожку
// `audio/red` и в каждый пакет кладёт два предыдущих кадра Opus. SFU такую дорожку знает (так
// приходит речь из Chrome): слушателям с RED отдаёт как есть, остальным — только основной кадр
// (`RedPrimaryReceiver`). Одиночные и парные потери (VPN, 1–6 %) слушатель не слышит вовсе; у
// Windows-клиента для его микрофона стоит то же `Enabled-2`.
//
// ЦЕНА. Полоса музыки вниз — до ×3 (160 → ≤ 480 Кбит/с на слушателя); владелец выбрал качество
// (R05, DECISIONS). Пакет не должен распасться на фрагменты IP: в `redBudget` помещаются три кадра
// по ≈ 400 байт (160 Кбит/с), а когда кадры крупнее — повторов кладётся столько, сколько влезает.

const (
	// Номер типа Opus внутри RED: SFU и браузеры договариваются о 111, fmtp RED — `111/111`
	// (`protocol/codecs.RedCodecParameters`).
	opusPayloadType = 111
	redPayloadType  = 63
	// Отсчётов на кадр при 48 кГц.
	samplesPerFrame = 960
	// Сколько байт полезной нагрузки RTP может занять пакет: с 12 байтами заголовка — 1200,
	// обычный MTU WebRTC и предел пакетизатора SDK.
	redBudget = 1180
	// Длина избыточного блока в заголовке RED — 10 бит.
	redBlockMax = 1023
	// Сколько предыдущих кадров повторять. Два — как `WebRTC-Audio-Red-For-Opus/Enabled-2/`:
	// пачка из двух потерь подряд восстанавливается целиком.
	redCopiesDefault = 2
	redCopiesMax     = 2
)

var redCapability = webrtc.RTPCodecCapability{
	MimeType:    "audio/red",
	ClockRate:   48000,
	Channels:    2,
	SDPFmtpLine: "111/111",
}

// redCopies — сколько повторов класть в пакет: `CORD_MUSIC_RED` 0…2, по умолчанию 2. Ноль —
// дорожка публикуется чистым Opus, как раньше (запасной ход, если SFU не договорился о RED).
func redCopies() int {
	value, err := strconv.Atoi(setting("CORD_MUSIC_RED", strconv.Itoa(redCopiesDefault)))
	if err != nil || value < 0 {
		return redCopiesDefault
	}
	return min(value, redCopiesMax)
}

// redPayload собирает пакет RED: заголовки блоков, повторы от старшего к младшему, затем основной
// кадр. `previous` — предыдущие кадры, ближайший первым. Что не влезает в `budget`, отбрасывается,
// начиная с самого старого повтора; слишком длинный для заголовка повтор не кладётся вовсе.
func redPayload(primary []byte, previous [][]byte, budget int) []byte {
	// Старший повтор — первым в пакете.
	blocks := make([][]byte, 0, len(previous))
	for i := len(previous) - 1; i >= 0; i-- {
		if len(previous[i]) <= redBlockMax {
			blocks = append(blocks, previous[i])
		}
	}
	size := 1 + len(primary)
	for _, block := range blocks {
		size += 4 + len(block)
	}
	for len(blocks) > 0 && size > budget {
		size -= 4 + len(blocks[0])
		blocks = blocks[1:]
	}
	out := make([]byte, 0, size)
	for i, block := range blocks {
		// F=1 | PT, 14 бит сдвига метки времени, 10 бит длины.
		offset := uint32(len(blocks)-i) * samplesPerFrame
		length := uint32(len(block))
		out = append(out,
			0x80|opusPayloadType,
			byte(offset>>6),
			byte(offset<<2)|byte(length>>8),
			byte(length),
		)
	}
	out = append(out, opusPayloadType)
	for _, block := range blocks {
		out = append(out, block...)
	}
	return append(out, primary...)
}

// sink — куда уходит кадр: дорожка Opus через SDK или дорожка RED со своими пакетами.
type sink interface {
	write(frame []byte, at time.Time) error
}

// redTrack — дорожка `audio/red`: пакеты RTP собираются здесь, SDK только подставляет SSRC и номер
// типа после договора. Метка времени идёт за стенными часами, как у `WriteSample` с `Timestamp`
// (см. `schedule`): замирание издателя для NetEq — обычная дыра, а не поток «из прошлого».
type redTrack struct {
	track   *webrtc.TrackLocalStaticRTP
	copies  int
	history [][]byte
	seq     uint16
	base    uint32
	started time.Time
}

func newRedTrack(copies int) (*redTrack, error) {
	track, err := webrtc.NewTrackLocalStaticRTP(redCapability, "music", "cord-music")
	if err != nil {
		return nil, err
	}
	return &redTrack{
		track:  track,
		copies: copies,
		seq:    uint16(rand.Uint32()),
		base:   rand.Uint32(),
	}, nil
}

// timestamp — метка RTP для момента `at`: 48 000 тактов в секунду от начала.
func (r *redTrack) timestamp(at time.Time) uint32 {
	if r.started.IsZero() {
		r.started = at
	}
	return r.base + uint32(at.Sub(r.started).Nanoseconds()*48/1_000_000)
}

func (r *redTrack) packet(frame []byte, at time.Time) *rtp.Packet {
	payload := redPayload(frame, r.history, redBudget)
	r.remember(frame)
	r.seq++
	return &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    redPayloadType,
			SequenceNumber: r.seq,
			Timestamp:      r.timestamp(at),
		},
		Payload: payload,
	}
}

// remember держит `copies` последних кадров, ближайший первым.
func (r *redTrack) remember(frame []byte) {
	if r.copies == 0 {
		return
	}
	kept := make([]byte, len(frame))
	copy(kept, frame)
	r.history = append([][]byte{kept}, r.history...)
	if len(r.history) > r.copies {
		r.history = r.history[:r.copies]
	}
}

func (r *redTrack) write(frame []byte, at time.Time) error {
	return r.track.WriteRTP(r.packet(frame, at))
}
