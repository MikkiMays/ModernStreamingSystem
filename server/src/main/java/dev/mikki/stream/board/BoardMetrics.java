package dev.mikki.stream.board;

import io.micrometer.core.instrument.FunctionCounter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Component;

/**
 * Доска в «Cord — встречи» (R159): сколько досок открыто и сколько у них сокетов, сколько элементов
 * принято и отклонено, не записалась ли сцена. Задержку штриха меряют сами браузеры
 * («Диагностика»), ядро её не знает.
 */
@Component
public class BoardMetrics {
  public BoardMetrics(BoardRooms boards, MeterRegistry registry) {
    Gauge.builder("cord.board.open", boards, b -> b.all().size())
        .description("Доски в памяти ядра")
        .register(registry);
    Gauge.builder("cord.board.peers", boards, BoardRooms::peerCount)
        .description("Сокеты досок — люди, которые сейчас видят доску")
        .register(registry);
    FunctionCounter.builder("cord.board.elements", boards, BoardRooms::accepted)
        .description("Правки элементов доски")
        .tag("result", "accepted")
        .register(registry);
    FunctionCounter.builder("cord.board.elements", boards, BoardRooms::rejected)
        .description("Правки элементов доски")
        .tag("result", "rejected")
        .register(registry);
    FunctionCounter.builder("cord.board.save.failures", boards, BoardRooms::saveFailures)
        .description("Сцена доски не записалась в базу")
        .register(registry);
  }
}
