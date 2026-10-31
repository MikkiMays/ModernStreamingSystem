package dev.mikki.stream.board;

import dev.mikki.stream.shared.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * Эфемерное сообщение доски (R159): курсор с лазером ({@link Presence}) и штрих «в процессе»
 * ({@link Ink}). Не хранится и может теряться — но не копится: пока сообщение ждёт отправки
 * медленному сокету, следующее того же автора <b>схлопывается</b> с ним ({@link #merge}). Курсору
 * нужно только последнее место, штриху — все точки: их дельты склеиваются в одну.
 */
public sealed interface Ephemeral permits Ephemeral.Presence, Ephemeral.Ink {
  /** По чему схлопывать: автор и вид, у штриха — ещё и сам штрих. */
  String key();

  /** Текст сообщения для сокета. */
  String render();

  /**
   * Это сообщение ждёт отправки, пришло {@code next} с тем же ключом: что отправить вместо обоих.
   */
  Ephemeral merge(Ephemeral next);

  /** Курсор, лазер и выделение участника — уже проверенным JSON-текстом. Важно только последнее. */
  record Presence(String key, String json) implements Ephemeral {
    @Override
    public String render() {
      return json;
    }

    @Override
    public Ephemeral merge(Ephemeral next) {
      return next;
    }
  }

  /**
   * Дельта точек штриха «в процессе»: {@code start} — номер первой точки, {@code points} — точки
   * {@code [x, y, нажим]} относительно начала штриха, {@code style} — вид штриха (цвет, толщина,
   * прозрачность, место) уже проверенным JSON-объектом, {@code t} — когда автор отправил (его часы,
   * поправленные по серверу), {@code st} — когда сообщение пришло в ядро.
   */
  record Ink(
      String key,
      String from,
      String stroke,
      long start,
      List<double[]> points,
      String style,
      long t,
      long st)
      implements Ephemeral {
    /**
     * Больше точек в одном склеенном сообщении не бывает: штрих такой длины уже не «в процессе».
     */
    static final int MAX_POINTS = 10_000;

    @Override
    public String render() {
      var body = new LinkedHashMap<String, Object>();
      body.put("type", "ink");
      body.put("from", from);
      body.put("id", stroke);
      body.put("start", start);
      body.put("pts", points);
      body.put("t", t);
      body.put("st", st);
      var text = Json.write(body);
      // Вид — уже готовый JSON: вставляется как есть, без второго разбора.
      return style == null ? text : text.substring(0, text.length() - 1) + ",\"el\":" + style + "}";
    }

    @Override
    public Ephemeral merge(Ephemeral next) {
      if (!(next instanceof Ink ink) || !ink.stroke.equals(stroke)) return next;
      long end = start + points.size();
      if (ink.start > end || ink.start < start) return next;
      var joined = new ArrayList<double[]>(points.size() + ink.points.size());
      joined.addAll(points);
      int skip = (int) (end - ink.start);
      for (int i = skip; i < ink.points.size() && joined.size() < MAX_POINTS; i++)
        joined.add(ink.points.get(i));
      return new Ink(
          key, from, stroke, start, joined, ink.style != null ? ink.style : style, ink.t, ink.st);
    }
  }
}
