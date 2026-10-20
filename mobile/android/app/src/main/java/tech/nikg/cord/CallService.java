package tech.nikg.cord;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/**
 * Разговор Cord как foreground service с типом {@code microphone}.
 *
 * <p>Зачем (docs/mobile.md §1, §4): Android выгружает процесс приложения, ушедшего в фон, а
 * foreground service с микрофоном — это то, что система обязана держать живым, пока висит его
 * уведомление. WebView с разговором живёт в том же процессе, поэтому, пока служба поднята, звук идёт
 * в обе стороны и при погашенном экране, и при свёрнутом приложении. Это та же защита, которую Chrome
 * даёт вкладке своим уведомлением «… использует микрофон», только наша и с кнопками разговора.
 *
 * <p>Поднимается страницей при входе во встречу (плагин {@link CordCallPlugin}), пока приложение на
 * экране: с Android 14 тип {@code microphone} можно начать только из видимого приложения
 * (while-in-use). Гасится при выходе из встречи и когда приложение смахнули из «Недавних».
 */
public class CallService extends Service {

    public static final String ACTION_START = "tech.nikg.cord.call.START";
    public static final String ACTION_STOP = "tech.nikg.cord.call.STOP";
    public static final String ACTION_HANGUP = "tech.nikg.cord.call.HANGUP";
    public static final String ACTION_MICROPHONE = "tech.nikg.cord.call.MICROPHONE";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_MICROPHONE = "microphone";

    private static final String CHANNEL = "call";
    private static final int NOTIFICATION_ID = 1;

    /** Кому сообщать о нажатиях в уведомлении. Ставит плагин, пока жив мост со страницей. */
    public interface Commands {
        void command(String action);
    }

    @Nullable
    private static volatile Commands commands;

    /** Служба, которая сейчас жива: обновлять её уведомление, а не поднимать заново. */
    @Nullable
    private static volatile CallService instance;

    /** Начало разговора — для часов в уведомлении; обновление названия их не сбрасывает. */
    private long startedAt = 0;
    private volatile boolean inCall = false;

    public static void setCommands(@Nullable Commands listener) {
        commands = listener;
    }

    /**
     * Поднять службу или обновить её уведомление. Обновление идёт мимо {@code startForegroundService}:
     * его нельзя звать из фона (Android 12+), а микрофон переключают и из уведомления, не открывая
     * приложение.
     */
    public static void start(Context context, String title, boolean microphone) {
        CallService running = instance;
        if (running != null && running.inCall) {
            running.update(title, microphone);
            return;
        }
        Intent intent = new Intent(context, CallService.class)
            .setAction(ACTION_START)
            .putExtra(EXTRA_TITLE, title)
            .putExtra(EXTRA_MICROPHONE, microphone);
        androidx.core.content.ContextCompat.startForegroundService(context, intent);
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, CallService.class));
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_HANGUP.equals(action) || ACTION_MICROPHONE.equals(action)) {
            Commands listener = commands;
            if (listener != null) listener.command(ACTION_HANGUP.equals(action) ? "hangup" : "microphone");
            // Нажатие в уведомлении, оставшемся от прошлого разговора, не должно оставить службу висеть.
            if (!inCall) stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action) || intent == null) {
            finish();
            return START_NOT_STICKY;
        }
        String title = intent.getStringExtra(EXTRA_TITLE);
        boolean microphone = intent.getBooleanExtra(EXTRA_MICROPHONE, true);
        if (!inCall) startedAt = System.currentTimeMillis();
        Notification notification = buildNotification(title != null ? title : getString(R.string.call_default_title), microphone);
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type);
            inCall = true;
        } catch (RuntimeException error) {
            // Android 14+: нет доступа к микрофону или приложение уже не на экране (while-in-use).
            // Разговор идёт как в браузере — без защиты от выгрузки. Плагин уже ответил странице «да»
            // (служба стартует после ответа), поэтому это видно только в журнале — см. docs/mobile.md §8.
            android.util.Log.w("CordCall", "foreground service refused", error);
            finish();
        }
        // Перезапуск после гибели процесса бессмыслен: разговор жил в WebView этого процесса.
        return START_NOT_STICKY;
    }

    private void update(String title, boolean microphone) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.notify(NOTIFICATION_ID, buildNotification(title, microphone));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    @Override
    public void onDestroy() {
        instance = null;
        inCall = false;
        super.onDestroy();
    }

    private Notification buildNotification(String title, boolean microphone) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL,
                getString(R.string.call_channel),
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription(getString(R.string.call_channel_description));
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        int immutable = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
        Intent open = new Intent(this, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | immutable);
        PendingIntent hangup = PendingIntent.getService(
            this,
            1,
            new Intent(this, CallService.class).setAction(ACTION_HANGUP),
            PendingIntent.FLAG_UPDATE_CURRENT | immutable
        );
        PendingIntent toggle = PendingIntent.getService(
            this,
            2,
            new Intent(this, CallService.class).setAction(ACTION_MICROPHONE),
            PendingIntent.FLAG_UPDATE_CURRENT | immutable
        );
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_call)
            .setContentTitle(title)
            .setContentText(getString(microphone ? R.string.call_text_microphone_on : R.string.call_text_microphone_off))
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(true)
            .setWhen(startedAt)
            .setUsesChronometer(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(content)
            .addAction(0, getString(microphone ? R.string.call_action_mute : R.string.call_action_unmute), toggle)
            .addAction(0, getString(R.string.call_action_hangup), hangup)
            .build();
    }

    private void finish() {
        inCall = false;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Приложение смахнули из «Недавних»: WebView со встречей уничтожен, разговора больше нет.
        finish();
        super.onTaskRemoved(rootIntent);
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
