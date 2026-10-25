package main

import (
	"math"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// ЗАЧЕМ. Куратор отличает потери хоста от потерь сети людей, и считать он должен честно: дыра в
// номерах — потеря, переполнение 16 бит — не потеря, дубликат — не приход нового.
func TestReceiveStatsCountsLossAcrossSequenceWrap(t *testing.T) {
	stats := &receiveStats{}
	at := time.Unix(1000, 0)
	for i, seq := range []uint16{65533, 65534, 65535, 1, 2} { // пропущен 0
		stats.add(seq, uint32(i)*samplesPerFrame, at.Add(time.Duration(i)*frame))
	}
	if stats.expected() != 6 || stats.received() != 5 {
		t.Fatalf("ожидалось 6 пакетов, пришло 5: %d %d", stats.expected(), stats.received())
	}
	if got := lossRatio(stats.expected(), stats.received()); math.Abs(got-1.0/6) > 1e-9 {
		t.Fatalf("доля потерь должна быть 1/6, а не %v", got)
	}
	if lossRatio(0, 0) != 0 || lossRatio(10, 12) != 0 {
		t.Fatal("без ожидаемых или с избытком потерь нет")
	}
}

// Пакеты ровно по 20 мс — джиттер ноль; один пакет опоздал на 30 мс — джиттер появился и затухает.
func TestReceiveStatsJitterFollowsRfc3550(t *testing.T) {
	stats := &receiveStats{}
	at := time.Unix(1000, 0)
	for i := 0; i < 20; i++ {
		stats.add(uint16(i), uint32(i)*samplesPerFrame, at.Add(time.Duration(i)*frame))
	}
	if stats.jitterMs() != 0 {
		t.Fatalf("ровный приход — джиттер ноль, а не %v", stats.jitterMs())
	}
	stats.add(20, 20*samplesPerFrame, at.Add(20*frame+30*time.Millisecond))
	// D = 30 мс = 1440 тактов; J = 1440/16 = 90 тактов = 1,875 мс.
	if got := stats.jitterMs(); math.Abs(got-1.875) > 1e-6 {
		t.Fatalf("после опоздания на 30 мс джиттер должен быть 1,875 мс, а не %v", got)
	}
	stats.add(21, 21*samplesPerFrame, at.Add(21*frame+30*time.Millisecond))
	if got := stats.jitterMs(); got >= 1.875 {
		t.Fatalf("ровный приход после — джиттер затухает: %v", got)
	}
}

// Оборот по отчёту приёмника: сейчас − LSR − DLSR. Отчёт без LSR (до нашего первого SR) оборота не даёт.
func TestRttFromReceiverReport(t *testing.T) {
	now := time.Unix(1_700_000_000, 500_000_000)
	sent := now.Add(-200 * time.Millisecond)
	dlsr := uint32(65536 / 20) // SFU держал отчёт 50 мс
	rtt, ok := rttFromReport(now, ntpCompact(sent), dlsr)
	if !ok || math.Abs(rtt.Seconds()-0.15) > 0.001 {
		t.Fatalf("оборот должен быть 150 мс: %v %v", rtt, ok)
	}
	if _, ok := rttFromReport(now, 0, dlsr); ok {
		t.Fatal("без LSR оборота нет")
	}
	// Часы разошлись: LSR «из будущего» — не отрицательный оборот, а «неизвестно».
	if _, ok := rttFromReport(now, ntpCompact(now.Add(time.Second)), 0); ok {
		t.Fatal("отчёт из будущего оборота не даёт")
	}
	up := &upstream{}
	up.report(now, rtcp.ReceptionReport{TotalLost: 3, Jitter: 480, LastSenderReport: ntpCompact(sent), Delay: dlsr})
	if !up.rttKnown || up.lost != 3 || up.jitter != 480 {
		t.Fatalf("отчёт должен лечь в сводку: %+v", up)
	}
}

// Метрики пробы — только перечислимые метки, и ряды есть с первого сбора.
func TestProbeMetricsRenderWithoutPersonalLabels(t *testing.T) {
	registry := prometheus.NewRegistry()
	metrics := newProbeMetrics(registry)
	metrics.record(probeResult{
		sent: 500, received: 495, lossDown: 0.01, lossUp: 0, jitterDownMs: 2.5, jitterUpMs: 1,
		rttMs: 42, rttKnown: true,
	}, 14*time.Second)
	metrics.runs.WithLabelValues("error").Inc()
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, family := range families {
		names[family.GetName()] = true
	}
	for _, want := range []string{
		"cord_probe_loss_ratio", "cord_probe_jitter_ms", "cord_probe_rtt_ms", "cord_probe_packets",
		"cord_probe_runs_total", "cord_probe_last_success_timestamp_seconds", "cord_probe_run_seconds",
	} {
		if !names[want] {
			t.Errorf("нет метрики %s", want)
		}
	}
	if got := testutil.ToFloat64(metrics.loss.WithLabelValues("down")); got != 0.01 {
		t.Fatalf("потери вниз должны быть 0,01: %v", got)
	}
	if got := testutil.ToFloat64(metrics.runs.WithLabelValues("ok")); got != 1 {
		t.Fatalf("одна удачная проба: %v", got)
	}
	text := strings.Builder{}
	for _, family := range families {
		for _, metric := range family.GetMetric() {
			for _, label := range metric.GetLabel() {
				text.WriteString(label.GetName() + "=" + label.GetValue() + " ")
			}
		}
	}
	if strings.Contains(text.String(), "cord-probe") {
		t.Fatal("в метках нет ни комнаты, ни участников — только перечисления")
	}
}
