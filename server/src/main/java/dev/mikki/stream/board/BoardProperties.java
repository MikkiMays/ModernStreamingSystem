package dev.mikki.stream.board;

import jakarta.validation.constraints.Min;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/**
 * Пределы доски (R159, {@code stream.board}). Числа — из проекта доски ({@code
 * docs/superpowers/specs/2026-10-31-board-design.md}): сцена Excalidraw на встречу в двадцать
 * человек, а не архив чертежей.
 *
 * @param maxElements сколько видимых элементов держит сцена
 * @param maxIds сколько элементов вместе с удалёнными: удалённый элемент остаётся отметкой, чтобы
 *     вернувшийся без сети не воскресил его своей старой копией
 * @param maxSceneBytes сколько байт JSON занимает вся сцена
 * @param maxElementBytes сколько байт JSON занимает один элемент
 * @param maxMessageBytes одно сообщение сокета доски — браузер режет правки на части меньше этого
 * @param maxFiles сколько картинок на доске
 * @param maxFileBytes предел одной картинки
 * @param ringBatches сколько последних пачек правок помнится для возврата по {@code since}
 * @param ringBytes сколько байт они занимают
 * @param outboxBytes сколько надёжных сообщений копится у одного сокета; больше — сокет медленный,
 *     он закрывается и при возврате берёт сцену заново
 * @param flushMs как часто сцена с правками пишется в базу
 * @param idleMs сколько доска без сокетов живёт в памяти после записи
 * @param sendTimeoutMs сколько можно ждать одной отправки, прежде чем счесть сокет мёртвым
 */
@Validated
@ConfigurationProperties("stream.board")
public record BoardProperties(
    @DefaultValue("10000") @Min(1) int maxElements,
    @DefaultValue("20000") @Min(1) int maxIds,
    @DefaultValue("8388608") @Min(1024) long maxSceneBytes,
    @DefaultValue("65536") @Min(1024) int maxElementBytes,
    @DefaultValue("98304") @Min(1024) int maxMessageBytes,
    @DefaultValue("32") @Min(0) int maxFiles,
    @DefaultValue("4194304") @Min(1024) int maxFileBytes,
    @DefaultValue("512") @Min(1) int ringBatches,
    @DefaultValue("4194304") @Min(1024) long ringBytes,
    @DefaultValue("16777216") @Min(65536) long outboxBytes,
    @DefaultValue("3000") @Min(100) long flushMs,
    @DefaultValue("60000") @Min(1000) long idleMs,
    @DefaultValue("10000") @Min(1000) long sendTimeoutMs) {

  /** Пределы по умолчанию — для тестов и того, кто собирает доску без Spring. */
  public static BoardProperties defaults() {
    return new BoardProperties(
        10_000, 20_000, 8L << 20, 64 << 10, 96 << 10, 32, 4 << 20, 512, 4L << 20, 16L << 20, 3000,
        60_000, 10_000);
  }
}
