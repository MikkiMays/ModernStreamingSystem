package main

import (
	"bufio"
	"fmt"
	"io"
)

// Ogg carries Opus in pages, and a page is not a packet: it may hold several frames, and one
// frame may span two pages. The RTP packetiser needs whole frames, so the lacing table has to
// be read — handing it a page whose size happens to exceed the MTU is the failure that looks
// like «the track publishes and nothing plays».
type oggStream struct {
	reader  *bufio.Reader
	partial []byte
}

func newOggStream(source io.Reader) *oggStream {
	return &oggStream{reader: bufio.NewReaderSize(source, 1<<16)}
}

// next returns the complete Opus packets of the following page, in order.
func (s *oggStream) next() ([][]byte, error) {
	var header [27]byte
	if _, err := io.ReadFull(s.reader, header[:]); err != nil {
		return nil, err
	}
	if string(header[0:4]) != "OggS" || header[4] != 0 {
		return nil, fmt.Errorf("поток не похож на Ogg")
	}
	continued := header[5]&0x01 != 0
	table := make([]byte, int(header[26]))
	if _, err := io.ReadFull(s.reader, table); err != nil {
		return nil, err
	}
	total := 0
	for _, size := range table {
		total += int(size)
	}
	payload := make([]byte, total)
	if _, err := io.ReadFull(s.reader, payload); err != nil {
		return nil, err
	}
	if !continued {
		s.partial = nil
	}
	packets := make([][]byte, 0, len(table))
	offset := 0
	for _, size := range table {
		s.partial = append(s.partial, payload[offset:offset+int(size)]...)
		offset += int(size)
		// Anything shorter than a full segment ends the packet; 255 means it goes on.
		if size < 255 {
			packets = append(packets, s.partial)
			s.partial = nil
		}
	}
	return packets, nil
}
