package dev.mikki.stream.room;

/**
 * Доску очистили командой {@code board.clear} (R159): у всех пустой холст и новое поколение сцены.
 *
 * <p>Сама сцена живёт не в комнате, а в {@code board.BoardRooms}: команда здесь проверяет право и
 * объявляет очистку, а сокет доски после фиксации стирает сцену, её картинки и говорит об этом
 * всем. {@code by} — кто очистил.
 */
public record BoardCleared(String roomId, String by) {}
