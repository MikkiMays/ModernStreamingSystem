package dev.mikki.stream.game;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import dev.mikki.stream.game.GarticView.*;
import dev.mikki.stream.shared.Problem;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;

/**
 * Two drawing games sharing bounded geometry, room identities and private per-viewer projections.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public class Gartic {
  public static final long LINGER_MS = 600_000;
  public static final int MAX_PLAYERS = 10;
  public static final int MAX_STROKES = 256;
  public static final int MAX_POINTS = 4000;
  private static final long CHOOSE_MS = 15_000;
  private static final long REVEAL_MS = 5000;
  private static final long TEXT_MS = 45_000;
  private static final long PHONE_DRAW_MS = 90_000;
  private static final ObjectMapper JSON =
      new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
  private static final SecureRandom RANDOM = new SecureRandom();

  // Original vocabulary assembled for Cord; no third-party word database or artwork.
  private static final List<String> WORDS =
      List.of(
          ("воздушный шар,кошка,собака,снеговик,самолёт,ракета,чайник,велосипед,"
                  + "зонтик,маяк,кактус,мороженое,пицца,арбуз,гитара,барабан,"
                  + "космонавт,пират,русалка,дракон,робот,динозавр,осьминог,пингвин,"
                  + "кенгуру,жираф,слон,крокодил,черепаха,бабочка,стрекоза,улитка,"
                  + "ежик,белка,медведь,лиса,волк,заяц,сова,павлин,"
                  + "паровоз,трамвай,автобус,подводная лодка,парусник,вертолёт,трактор,самокат,"
                  + "замок,мост,мельница,палатка,иглу,небоскрёб,бассейн,фонтан,"
                  + "радуга,молния,солнце,луна,снежинка,вулкан,водопад,остров,"
                  + "гриб,подсолнух,пальма,ёлка,цветок,вишня,ананас,банан,"
                  + "лимон,морковь,тыква,огурец,яичница,торт,бублик,чашка,"
                  + "ложка,вилка,кастрюля,сковорода,холодильник,тостер,пылесос,стиральная машина,"
                  + "будильник,телефон,телевизор,ноутбук,фотоаппарат,телескоп,микроскоп,компас,"
                  + "рюкзак,чемодан,ботинок,перчатка,шарф,корона,очки,цилиндр,"
                  + "подарок,свеча,фонарик,ключ,замочная скважина,лестница,качели,гамак,"
                  + "скейтборд,ролики,лыжи,сноуборд,футбольный мяч,баскетбольное кольцо,ракетка,гантеля,"
                  + "шахматы,пазл,кубик,матрёшка,юла,воздушный змей,мыльный пузырь,медаль,"
                  + "скрипка,саксофон,рояль,микрофон,наушники,нота,книга,конверт,"
                  + "почтовый ящик,карандаш,кисть,ножницы,линейка,глобус,магнит,подкова,"
                  + "светофор,дорожный конус,шлагбаум,колесо,якорь,штурвал,спасательный круг,мостик,"
                  + "сокровище,карта,привидение,волшебная палочка,летающая тарелка,супергерой,рыцарь,фея,"
                  + "пчела,божья коровка,морская звезда,акула,дельфин,кит,краб,медуза,"
                  + "аист,ворона,утка,гусь,петух,цыплёнок,лошадь,корова,"
                  + "пожарная машина,экскаватор,бульдозер,фуникулёр,канатная дорога,эскалатор,лифт,сани,"
                  + "верблюд,лама,носорог,бегемот,коала,панда,енот,бобр,"
                  + "садовая лейка,лопата,грабли,тачка,ведро,метла,скворечник,кормушка")
              .split(","));

  public String gameId;
  public String hostId;
  public String mode = "classic";
  public String phase = "lobby";
  public long openedAt;
  public long revision;
  public long turnToken;
  public long deadline;
  public long phaseStartedAt;
  public long idleSince;
  public int rounds = 3;
  public int turnSeconds = 60;
  public int round;
  public int step;
  public int totalSteps;
  public int turnIndex;
  public int hintLevel;
  public String drawerId;
  public String word;
  public List<String> choices = new ArrayList<>();
  public Set<String> usedWords = new LinkedHashSet<>();
  public List<Player> players = new ArrayList<>();
  public List<String> roster = new ArrayList<>();
  public Canvas drawing = new Canvas();
  public Map<String, Canvas> drafts = new LinkedHashMap<>();
  public List<Album> albums = new ArrayList<>();
  public List<GarticGuess> guesses = new ArrayList<>();
  public long guessSequence;
  public int revealAlbum;
  public int revealEntry;

  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Player {
    public String memberId;
    public String name;
    public int score;
    public boolean away;
    public boolean active = true;
    public boolean joined = true;
    public boolean guessed;
    public boolean submitted;
  }

  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Canvas {
    public List<GarticStroke> strokes = new ArrayList<>();
    // Tombstones make retries after undo/clear harmless, while bounding memory per phase.
    public Set<String> seen = new LinkedHashSet<>();
    public int points;
  }

  @JsonIgnoreProperties(ignoreUnknown = true)
  public static class Album {
    public String ownerId;
    public String ownerName;
    public List<GarticEntry> entries = new ArrayList<>();
  }

  public static Gartic open(String hostId, String name, String mode, long now) {
    var game = new Gartic();
    game.gameId = UUID.randomUUID().toString();
    game.hostId = hostId;
    game.openedAt = now;
    game.phaseStartedAt = now;
    game.mode = validMode(mode == null ? "classic" : mode);
    game.join(hostId, name, now);
    return game;
  }

  public void join(String memberId, String name, long now) {
    var player = player(memberId);
    if (player != null) {
      player.name = name;
      player.away = false;
      player.joined = true;
      if (!playing()) player.active = true;
    } else {
      if (!playing()) players.removeIf(p -> !p.joined);
      if (players.size() >= MAX_PLAYERS) fail("GARTIC_FULL", "В игре уже десять участников");
      player = new Player();
      player.memberId = memberId;
      player.name = name;
      player.active = !playing();
      players.add(player);
    }
    idleSince = 0;
    revision++;
  }

  public void leave(String memberId, long now) {
    var player = player(memberId);
    if (player == null) return;
    if (!playing()) {
      players.remove(player);
    } else {
      player.joined = false;
      player.active = false;
      if (mode.equals("classic")) {
        if (activeCount() == 0) transition("finished", now, 0);
        else if ((phase.equals("choosing") || phase.equals("drawing"))
            && (Objects.equals(drawerId, memberId) || everyoneGuessed())) endClassicTurn(now);
      } else if (phoneTask()) {
        if (!player.submitted && roster.contains(memberId)) completePhone(player, null);
        if (everyoneSubmitted()) nextPhoneStep(now);
      }
    }
    revision++;
  }

  public void configure(String option, Long value, long now) {
    if (playing()) fail("GARTIC_STARTED", "Настройки доступны между партиями");
    switch (option == null ? "" : option) {
      case "classic", "telephone" -> mode = option;
      case "rounds" -> {
        if (value == null || value < 2 || value > 5)
          fail("GARTIC_SETTING", "Нужно от двух до пяти кругов");
        rounds = value.intValue();
      }
      case "turn-seconds", "turnSeconds" -> {
        if (value == null || !List.of(45L, 60L, 90L).contains(value))
          fail("GARTIC_SETTING", "Время рисования: 45, 60 или 90 секунд");
        turnSeconds = value.intValue();
      }
      default -> fail("GARTIC_SETTING", "Неизвестная настройка");
    }
    revision++;
  }

  public void start(long now) {
    if (playing()) fail("GARTIC_STARTED", "Партия уже идёт");
    var available = players.stream().filter(p -> p.joined && !p.away).toList();
    int minimum = mode.equals("classic") ? 2 : 3;
    if (available.size() < minimum)
      fail("GARTIC_PLAYERS", "Недостаточно игроков: нужно " + minimum);
    gameId = UUID.randomUUID().toString();
    roster = new ArrayList<>(available.stream().map(p -> p.memberId).toList());
    players.forEach(
        p -> {
          p.active = roster.contains(p.memberId);
          p.score = 0;
          p.guessed = false;
          p.submitted = false;
        });
    choices.clear();
    usedWords.clear();
    guesses.clear();
    drafts.clear();
    albums.clear();
    drawing = new Canvas();
    word = null;
    drawerId = null;
    round = 1;
    step = 0;
    turnIndex = 0;
    revealAlbum = 0;
    revealEntry = 0;
    totalSteps = mode.equals("telephone") ? roster.size() : rounds * roster.size();
    if (mode.equals("classic")) beginClassicTurn(now);
    else {
      for (String id : roster) {
        var album = new Album();
        album.ownerId = id;
        album.ownerName = player(id).name;
        albums.add(album);
      }
      beginPhoneStep(now);
    }
  }

  public void choose(String memberId, int index, long expectedTurn, long now) {
    requireTurn(expectedTurn, now);
    if (!phase.equals("choosing") || !Objects.equals(drawerId, memberId))
      fail("GARTIC_ACTION", "Слово выбирает рисующий");
    if (index < 0 || index >= choices.size()) fail("GARTIC_WORD", "Выберите слово из списка");
    word = choices.get(index);
    usedWords.add(word);
    choices.clear();
    transition("drawing", now, turnSeconds * 1000L);
  }

  public void draw(String memberId, String compactJson, long expectedTurn, long now) {
    requireTurn(expectedTurn, now);
    var target = editableCanvas(memberId);
    var incoming = parseStrokes(compactJson);
    var unique = new LinkedHashMap<String, GarticStroke>();
    for (var stroke : incoming)
      if (!target.seen.contains(stroke.id())) unique.putIfAbsent(stroke.id(), stroke);
    int addedPoints = unique.values().stream().mapToInt(s -> s.points().size()).sum();
    if (target.seen.size() + unique.size() > 1024)
      fail("GARTIC_STROKE_LIMIT", "Лимит новых штрихов за этот ход исчерпан");
    if (target.strokes.size() + unique.size() > MAX_STROKES
        || target.points + addedPoints > MAX_POINTS)
      fail("GARTIC_CANVAS_LIMIT", "Рисунок заполнен: отмените штрих или очистите холст");
    if (unique.isEmpty()) return;
    target.strokes.addAll(unique.values());
    target.seen.addAll(unique.keySet());
    target.points += addedPoints;
    revision++;
  }

  public void canvas(String memberId, String action, long expectedTurn, long now) {
    requireTurn(expectedTurn, now);
    var target = editableCanvas(memberId);
    if ("clear".equals(action)) {
      target.strokes.clear();
      target.points = 0;
    } else if ("undo".equals(action)) {
      if (!target.strokes.isEmpty()) target.points -= target.strokes.removeLast().points().size();
    } else fail("GARTIC_ACTION", "Неизвестное действие с холстом");
    revision++;
  }

  public void guess(String memberId, String text, long expectedTurn, long now) {
    requireTurn(expectedTurn, now);
    var player = player(memberId);
    if (!mode.equals("classic")
        || !phase.equals("drawing")
        || player == null
        || !player.active
        || player.guessed
        || Objects.equals(memberId, drawerId)) fail("GARTIC_ACTION", "Сейчас нельзя угадывать");
    String cleaned = cleanText(text, 80);
    boolean correct = normalize(cleaned).equals(normalize(word));
    if (correct) {
      player.guessed = true;
      long remaining = Math.max(0, deadline - now);
      player.score += 250 + (int) (250 * remaining / (turnSeconds * 1000L));
      var drawer = player(drawerId);
      if (drawer != null) drawer.score += 100;
    }
    guesses.add(
        new GarticGuess(
            ++guessSequence,
            now,
            memberId,
            player.name,
            correct ? "Угадал слово" : cleaned,
            correct));
    while (guesses.size() > 50) guesses.removeFirst();
    revision++;
    if (everyoneGuessed()) endClassicTurn(now);
  }

  public void submit(String memberId, String text, long expectedTurn, long now) {
    requireTurn(expectedTurn, now);
    var player = player(memberId);
    if (!phoneTask()
        || player == null
        || !player.active
        || player.submitted
        || !roster.contains(memberId))
      fail("GARTIC_ACTION", "Задание уже завершено или недоступно");
    String cleaned = phase.equals("drawing") ? null : cleanText(text, 120);
    completePhone(player, cleaned);
    revision++;
    if (everyoneSubmitted()) nextPhoneStep(now);
  }

  /** Host authorization belongs to RoomService, as with start/configure. */
  public void reveal(int album, int entry, long expectedTurn, long now) {
    requireTurn(expectedTurn, now);
    if (!mode.equals("telephone") || !phase.equals("reveal"))
      fail("GARTIC_ACTION", "Альбомы ещё не готовы");
    if (album < 0
        || album >= albums.size()
        || entry < 0
        || entry >= albums.get(album).entries.size()) fail("GARTIC_ENTRY", "Такой страницы нет");
    revealAlbum = album;
    revealEntry = entry;
    turnToken++;
    revision++;
  }

  public boolean tick(long now) {
    boolean changed = false;
    // Bounded catch-up retains the original schedule after a restart or a delayed ticker.
    for (int advances = 0; deadline > 0 && now >= deadline && advances < 200; advances++) {
      long at = deadline;
      if (mode.equals("classic")) {
        switch (phase) {
          case "choosing" -> {
            word = choices.getFirst();
            usedWords.add(word);
            choices.clear();
            transition("drawing", at, turnSeconds * 1000L);
          }
          case "drawing" -> endClassicTurn(at);
          case "round-reveal" -> {
            turnIndex++;
            beginClassicTurn(at);
          }
          default -> deadline = 0;
        }
      } else if (phoneTask()) {
        for (String id : roster) {
          var player = player(id);
          if (!player.submitted) completePhone(player, null);
        }
        nextPhoneStep(at);
      } else deadline = 0;
      changed = true;
    }
    if (mode.equals("classic") && phase.equals("drawing")) {
      int level = scheduledHintLevel(now);
      if (level > hintLevel) {
        hintLevel = level;
        revision++;
        changed = true;
      }
    }
    return changed;
  }

  public boolean presence(Set<String> present, long now) {
    boolean changed = false;
    for (var player : players) {
      boolean away = !present.contains(player.memberId);
      if (away != player.away) {
        player.away = away;
        changed = true;
      }
    }
    if (mode.equals("classic") && (phase.equals("choosing") || phase.equals("drawing"))) {
      if (activeCount() == 0) {
        transition("finished", now, 0);
        changed = true;
      } else if (player(drawerId).away || everyoneGuessed()) {
        endClassicTurn(now);
        changed = true;
      }
    } else if (phoneTask()) {
      for (String id : roster) {
        var player = player(id);
        if (player.away && !player.submitted) {
          completePhone(player, null);
          changed = true;
        }
      }
      if (everyoneSubmitted()) {
        nextPhoneStep(now);
        changed = true;
      }
    }
    if (changed) revision++;
    return changed;
  }

  public boolean rebind(String previousId, String memberId, String name) {
    var player = player(previousId);
    if (player == null || previousId.equals(memberId)) return false;
    if (player(memberId) != null) fail("GARTIC_IDENTITY", "Участник уже присутствует в игре");
    player.memberId = memberId;
    player.name = name;
    player.away = false;
    if (Objects.equals(hostId, previousId)) hostId = memberId;
    if (Objects.equals(drawerId, previousId)) drawerId = memberId;
    Collections.replaceAll(roster, previousId, memberId);
    var draft = drafts.remove(previousId);
    if (draft != null) drafts.put(memberId, draft);
    for (var album : albums) {
      if (Objects.equals(album.ownerId, previousId)) {
        album.ownerId = memberId;
        album.ownerName = name;
      }
      album.entries.replaceAll(
          e ->
              Objects.equals(e.authorId(), previousId)
                  ? new GarticEntry(
                      memberId, name, e.kind(), e.text(), e.strokes(), e.skipped(), e.step())
                  : e);
    }
    guesses.replaceAll(
        g ->
            Objects.equals(g.memberId(), previousId)
                ? new GarticGuess(g.id(), g.at(), memberId, name, g.text(), g.correct())
                : g);
    revision++;
    return true;
  }

  public void host(String memberId) {
    if (!Objects.equals(hostId, memberId)) {
      hostId = memberId;
      revision++;
    }
  }

  public boolean playing() {
    return !List.of("lobby", "finished", "reveal").contains(phase);
  }

  public boolean linger(long now, long since) {
    boolean deserted = !playing() && players.stream().noneMatch(p -> p.active && !p.away);
    if (!deserted) {
      if (idleSince != 0) {
        idleSince = 0;
        revision++;
      }
      return false;
    }
    if (idleSince == 0 || idleSince > now || idleSince < since) {
      idleSince = now;
      revision++;
      return false;
    }
    return now - idleSince >= LINGER_MS;
  }

  public long closesAt() {
    return idleSince == 0 ? 0 : idleSince + LINGER_MS;
  }

  public GarticView view(String viewerId, long now) {
    var player = player(viewerId);
    if (player != null && !player.joined) player = null;
    boolean classic = mode.equals("classic");
    boolean participant =
        player != null && player.active && (phase.equals("lobby") || roster.contains(viewerId));
    boolean drawer = participant && Objects.equals(drawerId, viewerId);
    boolean canDraw =
        participant && phase.equals("drawing") && (classic ? drawer : !player.submitted);
    boolean canGuess =
        participant && classic && phase.equals("drawing") && !drawer && !player.guessed;
    boolean canSubmit = participant && phoneTask() && !player.submitted;
    GarticEntry previous =
        !classic && participant && phoneTask() && step > 0 ? previousEntry(viewerId) : null;
    String prompt =
        classic
            ? (drawer && phase.equals("drawing") ? word : null)
            : previous != null && previous.kind().equals("text") ? previous.text() : null;
    var you =
        player == null
            ? null
            : new GarticYou(
                viewerId,
                participant,
                canDraw,
                canGuess,
                canSubmit,
                player.submitted,
                prompt,
                drawer && phase.equals("choosing") ? List.copyOf(choices) : List.of(),
                previous);
    List<GarticStroke> visibleCanvas = List.of();
    if (classic && List.of("drawing", "round-reveal", "finished").contains(phase))
      visibleCanvas = List.copyOf(drawing.strokes);
    else if (!classic && participant && phase.equals("drawing"))
      visibleCanvas = List.copyOf(drafts.get(viewerId).strokes);
    boolean publicAnswer = classic && (phase.equals("round-reveal") || phase.equals("finished"));
    boolean revealing = !classic && phase.equals("reveal");
    var metadata = new ArrayList<GarticAlbum>();
    if (revealing)
      for (int i = 0; i < albums.size(); i++) {
        var album = albums.get(i);
        metadata.add(new GarticAlbum(i, album.ownerId, album.ownerName, album.entries.size()));
      }
    var visiblePlayers =
        players.stream()
            .map(
                p ->
                    new GarticPlayer(
                        p.memberId, p.name, p.score, p.away, p.active, p.guessed, p.submitted))
            .toList();
    return new GarticView(
        gameId,
        hostId,
        mode,
        phase,
        revision,
        turnToken,
        round,
        rounds,
        turnSeconds,
        step,
        totalSteps,
        drawerId,
        deadline,
        phaseStartedAt,
        visiblePlayers,
        you,
        visibleCanvas,
        classic ? List.copyOf(guesses) : List.of(),
        publicAnswer ? word : null,
        classic && phase.equals("drawing") ? hint(now) : null,
        metadata,
        revealAlbum,
        revealEntry,
        revealing ? albums.get(revealAlbum).entries.get(revealEntry) : null,
        closesAt());
  }

  private void beginClassicTurn(long now) {
    if (activeCount() < 2) {
      transition("finished", now, 0);
      return;
    }
    while (turnIndex < totalSteps
        && (!player(roster.get(turnIndex % roster.size())).active
            || player(roster.get(turnIndex % roster.size())).away)) turnIndex++;
    if (turnIndex >= totalSteps) {
      transition("finished", now, 0);
      return;
    }
    round = turnIndex / roster.size() + 1;
    step = turnIndex;
    drawerId = roster.get(turnIndex % roster.size());
    word = null;
    hintLevel = 0;
    drawing = new Canvas();
    guesses.clear();
    players.forEach(p -> p.guessed = false);
    var candidates = new ArrayList<>(WORDS);
    candidates.removeAll(usedWords);
    Collections.shuffle(candidates, RANDOM);
    choices = new ArrayList<>(candidates.subList(0, 3));
    transition("choosing", now, CHOOSE_MS);
  }

  private void endClassicTurn(long now) {
    if (word == null && !choices.isEmpty()) word = choices.getFirst();
    choices.clear();
    transition("round-reveal", now, REVEAL_MS);
  }

  private boolean everyoneGuessed() {
    return players.stream()
        .filter(p -> p.active && !p.away && !Objects.equals(p.memberId, drawerId))
        .allMatch(p -> p.guessed);
  }

  private void beginPhoneStep(long now) {
    drafts.clear();
    for (String id : roster) {
      player(id).submitted = false;
      drafts.put(id, new Canvas());
    }
    String nextPhase = step == 0 ? "prompt" : step % 2 == 1 ? "drawing" : "describing";
    transition(nextPhase, now, nextPhase.equals("drawing") ? PHONE_DRAW_MS : TEXT_MS);
    for (String id : roster)
      if (!player(id).active || player(id).away) completePhone(player(id), null);
    if (everyoneSubmitted()) nextPhoneStep(now);
  }

  private void nextPhoneStep(long now) {
    step++;
    if (step >= totalSteps) {
      drafts.clear();
      transition("reveal", now, 0);
    } else beginPhoneStep(now);
  }

  private void completePhone(Player player, String text) {
    boolean isDrawing = phase.equals("drawing");
    var strokes =
        isDrawing ? List.copyOf(drafts.get(player.memberId).strokes) : List.<GarticStroke>of();
    boolean skipped = isDrawing ? strokes.isEmpty() : text == null;
    int chain = chainFor(player.memberId);
    albums
        .get(chain)
        .entries
        .add(
            new GarticEntry(
                player.memberId,
                player.name,
                isDrawing ? "drawing" : "text",
                isDrawing ? null : text == null ? "Задание пропущено" : text,
                strokes,
                skipped,
                step));
    player.submitted = true;
  }

  private int chainFor(String memberId) {
    return Math.floorMod(roster.indexOf(memberId) - step, roster.size());
  }

  private GarticEntry previousEntry(String memberId) {
    return albums.get(chainFor(memberId)).entries.get(step - 1);
  }

  private boolean everyoneSubmitted() {
    return roster.stream().allMatch(id -> player(id).submitted);
  }

  private boolean phoneTask() {
    return mode.equals("telephone") && List.of("prompt", "drawing", "describing").contains(phase);
  }

  private Canvas editableCanvas(String memberId) {
    var player = player(memberId);
    if (!phase.equals("drawing")
        || player == null
        || !player.active
        || (mode.equals("classic")
            ? !Objects.equals(drawerId, memberId)
            : player.submitted || !roster.contains(memberId)))
      fail("GARTIC_ACTION", "Этот холст сейчас недоступен для рисования");
    return mode.equals("classic") ? drawing : drafts.get(memberId);
  }

  private void requireTurn(long expectedTurn, long now) {
    if (expectedTurn != turnToken || (deadline > 0 && now >= deadline))
      fail("GARTIC_STALE_TURN", "Этот ход уже завершён. Дождитесь обновления игры");
  }

  private void transition(String nextPhase, long now, long duration) {
    phase = nextPhase;
    phaseStartedAt = now;
    deadline = duration == 0 ? 0 : now + duration;
    turnToken++;
    revision++;
  }

  private Player player(String memberId) {
    return players.stream()
        .filter(p -> Objects.equals(p.memberId, memberId))
        .findFirst()
        .orElse(null);
  }

  private long activeCount() {
    return players.stream().filter(p -> p.active && !p.away && roster.contains(p.memberId)).count();
  }

  private String hint(long now) {
    if (word == null) return null;
    int reveal = Math.max(hintLevel, scheduledHintLevel(now));
    var masked = new StringBuilder();
    int seen = 0;
    for (int i = 0; i < word.length(); i++) {
      char character = word.charAt(i);
      if (!Character.isLetter(character)) masked.append(character);
      else {
        masked.append(seen < reveal ? character : '_');
        seen++;
      }
    }
    return masked.toString();
  }

  private int scheduledHintLevel(long now) {
    if (word == null) return 0;
    long elapsed = Math.max(0, now - phaseStartedAt);
    if (word.length() >= 8 && elapsed >= turnSeconds * 750L) return 2;
    return word.length() >= 5 && elapsed >= turnSeconds * 500L ? 1 : 0;
  }

  private static String validMode(String mode) {
    if (!List.of("classic", "telephone").contains(mode))
      fail("GARTIC_MODE", "Неизвестный режим игры");
    return mode;
  }

  private static String cleanText(String text, int limit) {
    if (text == null) fail("GARTIC_TEXT", "Введите текст");
    String cleaned = text.strip().replaceAll("\\s+", " ");
    if (cleaned.isBlank()
        || cleaned.length() > limit
        || cleaned.codePoints().anyMatch(Character::isISOControl))
      fail("GARTIC_TEXT", "Нужен текст длиной от 1 до " + limit + " символов");
    return cleaned;
  }

  private static String normalize(String text) {
    return text.strip().toLowerCase(Locale.ROOT).replace('ё', 'е').replaceAll("\\s+", " ");
  }

  private static List<GarticStroke> parseStrokes(String text) {
    if (text == null || text.length() > 4000)
      fail("GARTIC_DRAWING", "Слишком большой пакет рисунка");
    try {
      var root = JSON.readTree(text);
      if (root == null || !root.isObject() || root.size() != 1 || !root.path("strokes").isArray())
        fail("GARTIC_DRAWING", "Неверный формат рисунка");
      var nodes = root.get("strokes");
      if (nodes.isEmpty() || nodes.size() > 32) fail("GARTIC_DRAWING", "Неверное число штрихов");
      var result = new ArrayList<GarticStroke>();
      for (var node : nodes) {
        if (!node.isObject()
            || node.size() != 4
            || !node.path("id").isTextual()
            || !node.path("color").isTextual()
            || !integer(node.path("width"), 1, 40))
          fail("GARTIC_DRAWING", "Неверные параметры штриха");
        String id = node.get("id").asText();
        String color = node.get("color").asText();
        if (!id.matches("[A-Za-z0-9_-]{1,36}") || !color.matches("#[0-9a-fA-F]{6}"))
          fail("GARTIC_DRAWING", "Неверный цвет или идентификатор штриха");
        var pointsNode = node.path("points");
        if (!pointsNode.isArray() || pointsNode.isEmpty() || pointsNode.size() > 128)
          fail("GARTIC_DRAWING", "Штрих должен содержать от 1 до 128 точек");
        var points = new ArrayList<List<Integer>>();
        for (var point : pointsNode) {
          if (!point.isArray()
              || point.size() != 2
              || !integer(point.get(0), 0, 1000)
              || !integer(point.get(1), 0, 1000))
            fail("GARTIC_DRAWING", "Координаты должны лежать внутри холста");
          points.add(List.of(point.get(0).intValue(), point.get(1).intValue()));
        }
        result.add(
            new GarticStroke(
                id,
                color.toLowerCase(Locale.ROOT),
                node.get("width").intValue(),
                List.copyOf(points)));
      }
      return result;
    } catch (Problem problem) {
      throw problem;
    } catch (Exception ignored) {
      throw Problem.conflict("GARTIC_DRAWING", "Не удалось прочитать рисунок");
    }
  }

  private static boolean integer(JsonNode value, int min, int max) {
    return value != null
        && value.isIntegralNumber()
        && value.canConvertToInt()
        && value.intValue() >= min
        && value.intValue() <= max;
  }

  private static void fail(String code, String message) {
    throw Problem.conflict(code, message);
  }
}
