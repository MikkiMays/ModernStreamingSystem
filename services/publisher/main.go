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
	// Насколько можно отстать от собственного расписания, прежде чем признать отставание
	// и перестать его догонять. Десять кадров — меньше, чем слышно как пауза, и заметно
	// больше, чем обычная неточность сна в загруженной системе.
	slack = 10 * frame
	// Сколько кадров декодера накопить, прежде чем трек станет слышен, и сколько держать
	// про запас дальше. Запас нужен не нам, а приёмнику: пока его нет, в комнату идёт
	// тишина, и к первой ноте буфер приёма уже полон — начало трека не догоняют рывком.
	lead  = 12
	depth = 100
)

// Двадцать миллисекунд цифровой тишины, закодированные Opus.
//
// ЗАЧЕМ. Пауза раньше означала «перестать слать пакеты». Для приёмника это неотличимо от
// оборванной связи: NetEq включает заглушку — тянет последний кадр и гасит его линейно по
// децибелам примерно полсекунды. Измерено на этом сервере: после команды «пауза» звук ещё
// 80 мс идёт как был, потом ползёт вниз по 3,2 дБ за 20 мс до нуля. **Это и есть «звук
// поломки» при нажатии на паузу.** То же самое звучало между треками и в начале каждого:
// там тоже была дыра в потоке.
//
// Поэтому поток теперь не прерывается никогда: нет музыки — идёт тишина. Кадр взят у самого
// libopus (`ffmpeg -f lavfi -i anullsrc=r=48000:cl=stereo -c:a libopus -application audio
// -frame_duration 20`) и разобран из Ogg; повторять его можно сколько угодно.
//
// Байты не случайны: TOC `0xFC` — это конфигурация 31, то есть CELT, fullband, 20 мс, стерео,
// один кадр в пакете. Ровно тот же режим, в котором приходит музыка, поэтому переход
// «музыка → тишина» декодер проходит своим перекрытием MDCT, без щелчка: проверено —
// наибольший скачок между соседними отсчётами на стыке равен обычному шагу синуса.
var quiet = []byte{0xFC, 0xFF, 0xFE}

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

// Битрейт можно понизить, не пересобирая образ: на узком или неровном канале меньший
// пакет реже застревает. По умолчанию комната получает то же, что и раньше.
func setting(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

// decode turns one track into the room's format: soxr to 48 kHz with dither, then Opus at a
// constrained 256 kbit/s so every 20 ms frame stays inside one packet. Seeking is asked for
// before the input, so ffmpeg jumps instead of decoding everything ahead of the mark.
//
// `-packet_loss` — это не запрос FEC, а указание кодеку, что кадр может не доехать: Opus в
// ответ меньше опирается на предыдущий кадр. По умолчанию — ноль, и вот почему.
//
// Раньше здесь стояло `5`, и платой считался «битрейт, которого с запасом». Померили на этом
// сервере (тон 1 кГц и 440 Гц по каналам, 256 кбит/с, всё остальное то же): с `-packet_loss 5`
// шум и искажения в расшифрованном сигнале **на 7–10 дБ громче**, чем без него, — −47,7 дБ
// против −57,6 дБ слева и −45,3 против −52,2 справа. Ровно столько же приходит и в комнату:
// запись с дорожки бота совпала с локальной расшифровкой до сотых долей децибела, то есть
// это цена кодирования, а не дороги. На хорошем канале она платится ни за что.
//
// Значение 1 libopus не отличает от нуля, так что настраивать имеет смысл от 2 и выше —
// и только там, где потери настоящие.
func decode(path string, position float64) *exec.Cmd {
	return exec.Command("ffmpeg",
		"-nostdin", "-v", "error", "-threads", "1",
		"-protocol_whitelist", "file,pipe",
		"-ss", strconv.FormatFloat(position, 'f', 3, 64),
		"-i", path,
		"-vn", "-sn", "-dn", "-map", "0:a:0",
		"-af", "aresample=resampler=soxr:precision=28:dither_method=triangular_hp",
		"-ac", "2", "-ar", "48000",
		"-c:a", "libopus", "-b:a", setting("CORD_MUSIC_BITRATE", "256k"), "-vbr", "constrained",
		"-packet_loss", setting("CORD_MUSIC_PACKET_LOSS", "0"),
		"-compression_level", "10", "-application", "audio", "-frame_duration", "20",
		"-f", "ogg", "-page_duration", "20000", "pipe:1",
	)
}

// source — один запущенный декодер: сам процесс и готовые кадры, которых ждёт расписание.
type source struct {
	process *exec.Cmd
	frames  chan []byte
	stop    chan struct{}
	ended   chan struct{}
	done    sync.WaitGroup
	epoch   int64
	origin  float64
	sent    int
	ready   bool
}

// player держит темп комнаты. Кадр уходит каждые двадцать миллисекунд всегда — музыка,
// если она есть, и тишина, если её нет. Дыр в потоке не бывает, поэтому приёмнику нечего
// прятать заглушкой, а счёт кадров и стенные часы не расходятся между треками.
//
// Запас декодера сбрасывается вместе с ним, поэтому пауза, перемотка и переключение
// слышны сразу и не спорят с тем, что успело накопиться.
type player struct {
	track   *lksdk.LocalTrack
	mu      sync.Mutex
	current *source
	written int
	started time.Time
}

func (p *player) halt() {
	p.mu.Lock()
	current := p.current
	p.current = nil
	p.mu.Unlock()
	if current == nil {
		return
	}
	close(current.stop)
	// Killing comes first: ffmpeg is usually blocked writing into a pipe nobody reads, and
	// a polite signal there is a wait with no end. Хоронит процесс тот же, кто его читал,
	// поэтому здесь достаточно дождаться его.
	_ = current.process.Process.Kill()
	current.done.Wait()
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
	current := &source{
		process: process,
		frames:  make(chan []byte, depth),
		stop:    make(chan struct{}),
		ended:   make(chan struct{}),
		epoch:   epoch,
		origin:  position,
	}
	current.done.Add(1)
	go func() {
		// Трек кончается двумя способами: сам и по команде. Похоронить процесс нужно в обоих,
		// и делать это должен тот, кто его читал: `Wait` закрывает трубу, поэтому звать её
		// может только тот, кто дочитал. Иначе закончившийся своим ходом ffmpeg оставался
		// зомби — по одному на трек, пока издатель жив.
		defer func() {
			pipe.Close()
			_ = process.Wait()
			close(current.frames)
			current.done.Done()
		}()
		stream := newOggStream(pipe)
		for {
			packets, err := stream.next()
			if err != nil {
				close(current.ended)
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
				// Кадр не влезает в пакет — значит, этих двадцати миллисекунд не будет.
				// Пропустить их нельзя: счёт кадров уедет, и дальше вся позиция врёт.
				// Тишина стоит того же места во времени, что и потерянный кадр.
				if len(packet) > maxPacket {
					packet = quiet
				}
				select {
				case current.frames <- packet:
				case <-current.stop:
					return
				}
			}
		}
	}()
	p.mu.Lock()
	p.current = current
	p.mu.Unlock()
}

// next — что уходит в комнату в ближайшие двадцать миллисекунд, и что об этом сказать.
func (p *player) next() ([]byte, *event) {
	p.mu.Lock()
	defer p.mu.Unlock()
	current := p.current
	if current == nil {
		return quiet, nil
	}
	if !current.ready {
		// Запас ещё набирается. Короткий трек может кончиться раньше, чем наберётся, —
		// тогда ждать больше нечего.
		select {
		case <-current.ended:
		default:
			if len(current.frames) < lead {
				return quiet, nil
			}
		}
		current.ready = true
	}
	select {
	case packet, ok := <-current.frames:
		if !ok {
			at := current.origin + float64(current.sent)*frame.Seconds()
			p.current = nil
			return quiet, &event{Event: "finished", Epoch: current.epoch, Value: &at}
		}
		current.sent++
		if current.sent%report == 0 {
			at := current.origin + float64(current.sent)*frame.Seconds()
			return packet, &event{Event: "position", Epoch: current.epoch, Value: &at}
		}
		return packet, nil
	default:
		// Декодер не успел: двадцать миллисекунд тишины дешевле, чем дыра в потоке.
		return quiet, nil
	}
}

// pace — единственное место, которое пишет в дорожку, и единственные часы издателя.
//
// ЗАЧЕМ ОТСЧЁТ ОБЩИЙ, А НЕ ПОТРЕКОВЫЙ. Раньше расписание начиналось заново с первым кадром
// каждого трека, а между треками поток прерывался. Теперь номер кадра растёт всё время, пока
// издатель жив, поэтому метки RTP идут ровно за стенными часами: приёмнику не приходится
// разбираться, что означает пауза в тридцать секунд с непрерывной нумерацией.
func (p *player) pace(stop <-chan struct{}) {
	p.started = time.Now()
	for ; ; p.written++ {
		deadline := p.started.Add(time.Duration(p.written) * frame)
		// Отстали заметно — значит, машина на время замерла. Отдавать накопленное залпом
		// нельзя: у приёмника это обернётся раздутым буфером и погоней за ним. Сдвигаем
		// отсчёт и играем дальше ровно — потерянные доли секунды всё равно не вернуть.
		if behind := time.Since(deadline); behind > slack {
			p.started = p.started.Add(behind)
			deadline = deadline.Add(behind)
		}
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
		packet, announcement := p.next()
		if err := p.track.WriteSample(media.Sample{Data: packet, Duration: frame}, nil); err != nil {
			say(event{Event: "closed", Message: err.Error()})
			return
		}
		if announcement != nil {
			say(*announcement)
		}
	}
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
	// Темп задаётся до первой команды: к моменту, когда зазвучит первый трек, буфер приёма
	// у всех уже полон тишиной, и начало не приходится догонять.
	paced := make(chan struct{})
	defer close(paced)
	go music.pace(paced)
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
