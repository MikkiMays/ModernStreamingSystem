// Cord's music publisher: one room, one stereo Opus track.
//
// ЗАЧЕМ ОТДЕЛЬНАЯ ПРОГРАММА. Музыку в комнату раньше отдавал Python-клиент LiveKit, и она
// приходила **в моно**: `TrackPublishOptions` этого SDK не умеет просить стерео, поэтому
// сервер договаривался об одном канале, а кодек сводил любую запись в моно. Поле `Stereo`
// есть только в Go-SDK — отсюда эта программа. Заодно кодирует ffmpeg, а не libwebrtc:
// Opus 256 кбит/с с профилем «audio» вместо голосового, с разбором soxr и дизерингом.
//
// Управление — построчный JSON на stdin, события — построчный JSON на stdout. Очередь,
// права, места в комнате и срок хранения остаются на стороне Python: здесь только звук.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	"github.com/livekit/protocol/logger"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

const (
	frame = 20 * time.Millisecond
	// One RTP packet has to fit the path. Constrained VBR at 256 kbit/s gives about 640
	// bytes per frame, so this is a guard against a broken encode, not a normal case.
	maxPacket = 1200
	// Опус в пакете один и тот же, а вот тишина в комнате слышна сразу: отчёт о позиции
	// раз в полсекунды — достаточно редко для журнала и достаточно часто для полосы.
	report = 25
)

type command struct {
	Cmd      string  `json:"cmd"`
	URL      string  `json:"url"`
	Token    string  `json:"token"`
	Name     string  `json:"name"`
	Path     string  `json:"path"`
	Position float64 `json:"position"`
	Epoch    int64   `json:"epoch"`
}

type event struct {
	Event   string   `json:"event"`
	Epoch   int64    `json:"epoch,omitempty"`
	Value   *float64 `json:"value,omitempty"`
	Message string   `json:"message,omitempty"`
}

var output = struct {
	sync.Mutex
	writer *bufio.Writer
}{writer: bufio.NewWriter(os.Stdout)}

func say(value event) {
	output.Lock()
	defer output.Unlock()
	data, err := json.Marshal(value)
	if err != nil {
		return
	}
	_, _ = output.writer.Write(append(data, '\n'))
	_ = output.writer.Flush()
}

// decode turns one track into the room's format: soxr to 48 kHz with dither, then Opus at a
// constrained 256 kbit/s so every 20 ms frame stays inside one packet. Seeking is asked for
// before the input, so ffmpeg jumps instead of decoding everything ahead of the mark.
func decode(path string, position float64) *exec.Cmd {
	return exec.Command("ffmpeg",
		"-nostdin", "-v", "error", "-threads", "1",
		"-protocol_whitelist", "file,pipe",
		"-ss", strconv.FormatFloat(position, 'f', 3, 64),
		"-i", path,
		"-vn", "-sn", "-dn", "-map", "0:a:0",
		"-af", "aresample=resampler=soxr:precision=28:dither_method=triangular_hp",
		"-ac", "2", "-ar", "48000",
		"-c:a", "libopus", "-b:a", "256k", "-vbr", "constrained",
		"-compression_level", "10", "-application", "audio", "-frame_duration", "20",
		"-f", "ogg", "-page_duration", "20000", "pipe:1",
	)
}

// player owns the decoder and the pace. Nothing is buffered beyond one frame, so a pause, a
// seek and a skip take effect now rather than after whatever was queued ahead of them.
type player struct {
	track    *lksdk.LocalTrack
	current  *exec.Cmd
	stop     chan struct{}
	finished sync.WaitGroup
}

func (p *player) halt() {
	if p.current == nil {
		return
	}
	close(p.stop)
	// Killing comes first: ffmpeg is usually blocked writing into a pipe nobody reads, and
	// a polite signal there is a wait with no end.
	_ = p.current.Process.Kill()
	p.finished.Wait()
	_ = p.current.Wait()
	p.current = nil
}

func (p *player) play(path string, position float64, epoch int64) {
	p.halt()
	process := decode(path, position)
	pipe, err := process.StdoutPipe()
	if err != nil {
		say(event{Event: "failed", Epoch: epoch, Message: err.Error()})
		return
	}
	process.Stderr = os.Stderr
	if err := process.Start(); err != nil {
		say(event{Event: "failed", Epoch: epoch, Message: err.Error()})
		return
	}
	p.current = process
	p.stop = make(chan struct{})
	stop := p.stop
	p.finished.Add(1)
	go func() {
		defer p.finished.Done()
		defer pipe.Close()
		stream := newOggStream(pipe)
		started := time.Now()
		written := 0
		for {
			packets, err := stream.next()
			if err != nil {
				select {
				case <-stop:
					return
				default:
				}
				at := position + float64(written)*frame.Seconds()
				say(event{Event: "finished", Epoch: epoch, Value: &at})
				return
			}
			for _, packet := range packets {
				// The two header packets describe the stream; they are not sound.
				if len(packet) >= 8 {
					switch string(packet[:8]) {
					case "OpusHead", "OpusTags":
						continue
					}
				}
				if len(packet) > maxPacket {
					continue
				}
				// Deadlines rather than a ticker: a ticker drops the ticks it missed, and
				// an hour of playback would drift away from the position being reported.
				deadline := started.Add(time.Duration(written) * frame)
				if wait := time.Until(deadline); wait > 0 {
					select {
					case <-stop:
						return
					case <-time.After(wait):
					}
				}
				select {
				case <-stop:
					return
				default:
				}
				if err := p.track.WriteSample(media.Sample{Data: packet, Duration: frame}, nil); err != nil {
					say(event{Event: "failed", Epoch: epoch, Message: err.Error()})
					return
				}
				written++
				if written%report == 0 {
					at := position + float64(written)*frame.Seconds()
					say(event{Event: "position", Epoch: epoch, Value: &at})
				}
			}
		}
	}()
}

func main() {
	// The SDK and pion log every ICE step at info level. Those lines end up in the service
	// journal, where they bury the ones that matter — and a container journal is a disk this
	// project has already filled once. Errors are kept; the play-by-play is not.
	logger.InitFromConfig(&logger.Config{Level: "error"}, "cord-publisher")
	lksdk.SetLogger(logger.GetLogger())
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		say(event{Event: "closed", Message: "нет команды подключения"})
		os.Exit(1)
	}
	var connect command
	if err := json.Unmarshal(line, &connect); err != nil || connect.Cmd != "connect" {
		say(event{Event: "closed", Message: "первой командой должна быть connect"})
		os.Exit(1)
	}
	room, err := lksdk.ConnectToRoomWithToken(connect.URL, connect.Token, &lksdk.RoomCallback{
		OnDisconnected: func() {
			say(event{Event: "closed", Message: "соединение с комнатой потеряно"})
			os.Exit(0)
		},
	}, lksdk.WithAutoSubscribe(false))
	if err != nil {
		say(event{Event: "closed", Message: err.Error()})
		os.Exit(1)
	}
	defer room.Disconnect()

	track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2,
	})
	if err != nil {
		say(event{Event: "closed", Message: err.Error()})
		os.Exit(1)
	}
	name := connect.Name
	if name == "" {
		name = "Музыка"
	}
	// Stereo is the whole reason this program exists: the server only tells subscribers to
	// decode two channels when the publisher says the track has them.
	if _, err := room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:       name,
		Source:     livekit.TrackSource_MICROPHONE,
		DisableDTX: true,
		Stereo:     true,
	}); err != nil {
		say(event{Event: "closed", Message: err.Error()})
		os.Exit(1)
	}
	music := &player{track: track}
	defer music.halt()
	say(event{Event: "ready"})

	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return // The service went away; so do we, and the room loses the bot.
		}
		var next command
		if err := json.Unmarshal(line, &next); err != nil {
			say(event{Event: "failed", Message: fmt.Sprintf("нераспознанная команда: %v", err)})
			continue
		}
		switch next.Cmd {
		case "play":
			music.play(next.Path, next.Position, next.Epoch)
		case "pause":
			music.halt()
		case "quit":
			return
		}
	}
}
