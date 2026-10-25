package main

import (
	"bytes"
	"testing"
	"time"
)

// Разбор одного пакета RED: заголовки блоков и сами блоки, основной — последним.
func parseRed(t *testing.T, payload []byte) (offsets []uint32, blocks [][]byte) {
	t.Helper()
	var lengths []uint32
	i := 0
	for payload[i]&0x80 != 0 {
		if payload[i]&0x7f != opusPayloadType {
			t.Fatalf("в блоке RED должен быть тип Opus %d, а не %d", opusPayloadType, payload[i]&0x7f)
		}
		offsets = append(offsets, uint32(payload[i+1])<<6|uint32(payload[i+2])>>2)
		lengths = append(lengths, uint32(payload[i+2]&0x03)<<8|uint32(payload[i+3]))
		i += 4
	}
	if payload[i] != opusPayloadType {
		t.Fatalf("основной блок должен быть Opus %d, а не %d", opusPayloadType, payload[i])
	}
	i++
	for _, length := range lengths {
		blocks = append(blocks, payload[i:i+int(length)])
		i += int(length)
	}
	return offsets, append(blocks, payload[i:])
}

// ЗАЧЕМ. RED у SFU (`active_red_encoding`) в 1.13.6 к дорожке на чистом Opus не применяется, поэтому
// повторы кладёт сам издатель. Пакет обязан быть ровно по RFC 2198: старший повтор первым, сдвиг
// метки — в кадрах по 960 отсчётов, иначе NetEq слушателя повторы не поймёт — и потери снова слышны.
func TestRedPayloadCarriesTwoPreviousFramesOldestFirst(t *testing.T) {
	primary := []byte{0xC0, 1, 2, 3}
	last := []byte{0xC1, 4, 5}
	older := []byte{0xC2, 6}
	offsets, blocks := parseRed(t, redPayload(primary, [][]byte{last, older}, redBudget))
	if len(offsets) != 2 || offsets[0] != 2*samplesPerFrame || offsets[1] != samplesPerFrame {
		t.Fatalf("сдвиги должны быть 1920 и 960, получено %v", offsets)
	}
	if !bytes.Equal(blocks[0], older) || !bytes.Equal(blocks[1], last) || !bytes.Equal(blocks[2], primary) {
		t.Fatalf("порядок блоков: старший, последний, основной; получено %v", blocks)
	}
	// Без истории — только основной кадр с однобайтовым заголовком.
	if got := redPayload(primary, nil, redBudget); !bytes.Equal(got, append([]byte{opusPayloadType}, primary...)) {
		t.Fatalf("без повторов пакет должен быть заголовок + кадр: %v", got)
	}
}

// Пакет не должен распасться на фрагменты IP: когда кадры крупные, повторов кладётся столько,
// сколько влезает в бюджет, — сначала теряется самый старый.
func TestRedPayloadDropsOldestCopiesOverBudget(t *testing.T) {
	primary := bytes.Repeat([]byte{1}, 500)
	last := bytes.Repeat([]byte{2}, 500)
	older := bytes.Repeat([]byte{3}, 500)
	offsets, blocks := parseRed(t, redPayload(primary, [][]byte{last, older}, redBudget))
	if len(offsets) != 1 || offsets[0] != samplesPerFrame {
		t.Fatalf("должен остаться один повтор — последний кадр, получено %v", offsets)
	}
	if !bytes.Equal(blocks[0], last) || !bytes.Equal(blocks[1], primary) {
		t.Fatalf("остаться должен последний кадр и основной: %d %d", len(blocks[0]), len(blocks[1]))
	}
	// Повтор длиннее 1023 байт в заголовок не помещается — его нет, основной кадр идёт как есть.
	huge := bytes.Repeat([]byte{4}, redBlockMax+1)
	offsets, blocks = parseRed(t, redPayload(primary, [][]byte{huge}, 10_000))
	if len(offsets) != 0 || len(blocks) != 1 {
		t.Fatalf("слишком длинный повтор должен быть пропущен: %v", offsets)
	}
}

// Дорожка RED сама ведёт номера и метки RTP: номер растёт на единицу, метка — 48 000 в секунду от
// стенных часов, и в историю попадают только `copies` последних кадров.
func TestRedTrackNumbersPacketsAndKeepsShortHistory(t *testing.T) {
	track, err := newRedTrack(2)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Unix(1000, 0)
	first := track.packet([]byte{1}, start)
	second := track.packet([]byte{2}, start.Add(frame))
	third := track.packet([]byte{3}, start.Add(2*frame))
	fourth := track.packet(quiet, start.Add(3*frame))
	if second.SequenceNumber != first.SequenceNumber+1 || third.SequenceNumber != second.SequenceNumber+1 {
		t.Fatalf("номера должны идти подряд: %d %d %d", first.SequenceNumber, second.SequenceNumber, third.SequenceNumber)
	}
	if second.Timestamp-first.Timestamp != samplesPerFrame || fourth.Timestamp-first.Timestamp != 3*samplesPerFrame {
		t.Fatalf("метка должна расти на 960 за кадр: %d %d", second.Timestamp-first.Timestamp, fourth.Timestamp-first.Timestamp)
	}
	if first.PayloadType != redPayloadType {
		t.Fatalf("пакет должен нести тип RED %d: %d", redPayloadType, first.PayloadType)
	}
	_, blocks := parseRed(t, fourth.Payload)
	if len(blocks) != 3 || !bytes.Equal(blocks[0], []byte{2}) || !bytes.Equal(blocks[1], []byte{3}) || !bytes.Equal(blocks[2], quiet) {
		t.Fatalf("в четвёртом пакете должны быть кадры 2, 3 и тишина: %v", blocks)
	}
	// Без повторов история не ведётся вовсе.
	plain, _ := newRedTrack(0)
	plain.packet([]byte{1}, start)
	if _, blocks := parseRed(t, plain.packet([]byte{2}, start.Add(frame)).Payload); len(blocks) != 1 {
		t.Fatalf("при нуле повторов в пакете один блок: %v", blocks)
	}
}

func TestRedCopiesSetting(t *testing.T) {
	t.Setenv("CORD_MUSIC_RED", "")
	if redCopies() != 2 {
		t.Fatalf("по умолчанию два повтора, а не %d", redCopies())
	}
	t.Setenv("CORD_MUSIC_RED", "0")
	if redCopies() != 0 {
		t.Fatal("ноль — чистый Opus")
	}
	t.Setenv("CORD_MUSIC_RED", "7")
	if redCopies() != redCopiesMax {
		t.Fatalf("больше %d повторов не кладётся", redCopiesMax)
	}
	t.Setenv("CORD_MUSIC_RED", "мусор")
	if redCopies() != 2 {
		t.Fatal("нечитаемое значение — по умолчанию")
	}
}
