package main

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// page собирает страницу Ogg из готовых пакетов — так же, как это делает ffmpeg. Если
// `unfinished`, последний пакет остаётся без завершающего сегмента: он продолжится на
// следующей странице. CRC разбор не проверяет, поэтому поле остаётся нулевым.
func page(sequence uint32, granule int64, flags byte, unfinished bool, packets [][]byte) []byte {
	var table, body []byte
	for i, packet := range packets {
		size := len(packet)
		for size >= 255 {
			table = append(table, 255)
			size -= 255
		}
		if !(unfinished && i == len(packets)-1) {
			table = append(table, byte(size))
		}
		body = append(body, packet...)
	}
	header := make([]byte, 27)
	copy(header, "OggS")
	header[5] = flags
	binary.LittleEndian.PutUint64(header[6:], uint64(granule))
	binary.LittleEndian.PutUint32(header[14:], 1)
	binary.LittleEndian.PutUint32(header[18:], sequence)
	header[26] = byte(len(table))
	return append(append(append([]byte{}, header...), table...), body...)
}

// ЗАЧЕМ. Страница Ogg — это не пакет: в ней может лежать несколько кадров, а один кадр может
// растянуться на две страницы. Пакетизатор RTP умеет только целые кадры, поэтому таблицу
// сегментов приходится читать. Ошибка здесь выглядит как «дорожка публикуется, а звука нет».
func TestOggStreamRebuildsWholePackets(t *testing.T) {
	long := bytes.Repeat([]byte{0xAA}, 300)  // 300 = 255 + 45, то есть два сегмента
	exact := bytes.Repeat([]byte{0xBB}, 255) // ровно сегмент: за ним обязан идти нулевой
	stream := newOggStream(bytes.NewReader(bytes.Join([][]byte{
		page(0, 0, 2, false, [][]byte{[]byte("OpusHead")}),
		page(1, 960, 0, false, [][]byte{long, exact}),
		// Кадр, разорванный между страницами: хвост приходит со взведённым флагом «продолжение».
		page(2, 1920, 0, true, [][]byte{bytes.Repeat([]byte{0xCC}, 255)}),
		page(3, 2880, 1, false, [][]byte{[]byte("хвост")}),
	}, nil)))

	var collected [][]byte
	for {
		packets, err := stream.next()
		if err != nil {
			break
		}
		collected = append(collected, packets...)
	}
	if len(collected) != 4 {
		t.Fatalf("ожидались четыре пакета, получено %d: %v", len(collected), collected)
	}
	if string(collected[0]) != "OpusHead" {
		t.Errorf("первым должен идти заголовок, а не %q", collected[0])
	}
	if len(collected[1]) != 300 || len(collected[2]) != 255 {
		t.Errorf("длины пакетов на одной странице разошлись: %d и %d", len(collected[1]), len(collected[2]))
	}
	if want := 255 + len("хвост"); len(collected[3]) != want {
		t.Errorf("разорванный кадр собран как %d байт, а не %d", len(collected[3]), want)
	}
}

// ЗАЧЕМ. Пауза, пустая очередь и промежуток между треками не должны быть дырой в потоке:
// для приёмника дыра неотличима от оборванной связи, и он полсекунды тянет и гасит последний
// кадр — это и слышно как «звук поломки». Здесь проверяется то самое обещание: кадр уходит
// всегда, а музыка начинается только после того, как набран запас.
func TestSilenceFillsEveryGap(t *testing.T) {
	if len(quiet) == 0 || quiet[0]>>3 != 31 || (quiet[0]>>2)&1 != 1 || quiet[0]&3 != 0 {
		t.Fatalf("кадр тишины должен быть одиночным стерео CELT fullband 20 мс, TOC %#x", quiet[0])
	}

	idle := &player{}
	if packet, announcement := idle.next(); !bytes.Equal(packet, quiet) || announcement != nil {
		t.Errorf("без трека в комнату должна идти тишина, а ушло %v", packet)
	}

	current := &source{frames: make(chan []byte, depth), ended: make(chan struct{}), epoch: 7}
	music := &player{current: current}
	current.frames <- []byte{1, 2, 3}
	if packet, _ := music.next(); !bytes.Equal(packet, quiet) {
		t.Errorf("пока запас не набран, играть рано: %v", packet)
	}
	for i := 0; i < lead; i++ {
		current.frames <- []byte{byte(i)}
	}
	if packet, _ := music.next(); !bytes.Equal(packet, []byte{1, 2, 3}) {
		t.Errorf("запас набран, а первым ушёл не первый кадр: %v", packet)
	}

	// Трек короче запаса всё равно должен зазвучать: ждать больше нечего.
	short := &source{frames: make(chan []byte, depth), ended: make(chan struct{})}
	brief := &player{current: short}
	short.frames <- []byte{9}
	close(short.ended)
	if packet, _ := brief.next(); !bytes.Equal(packet, []byte{9}) {
		t.Errorf("короткий трек не зазвучал: %v", packet)
	}
	close(short.frames)
	packet, announcement := brief.next()
	if !bytes.Equal(packet, quiet) || announcement == nil || announcement.Event != "finished" {
		t.Errorf("конец трека должен быть объявлен и заполнен тишиной: %v, %v", packet, announcement)
	}
	if brief.current != nil {
		t.Error("досказанный трек должен быть отпущен")
	}
}

// Декодер, который не поспевает, не должен рвать поток: его место занимает тишина, а счёт
// кадров продолжает идти — иначе позиция в треке начинает врать.
func TestSlowDecoderYieldsSilenceNotAHole(t *testing.T) {
	current := &source{frames: make(chan []byte, depth), ended: make(chan struct{}), ready: true}
	music := &player{current: current}
	if packet, _ := music.next(); !bytes.Equal(packet, quiet) {
		t.Errorf("при пустом запасе ожидалась тишина, а не %v", packet)
	}
	if current.sent != 0 {
		t.Errorf("тишина не считается кадром трека, а счётчик стал %d", current.sent)
	}
}
