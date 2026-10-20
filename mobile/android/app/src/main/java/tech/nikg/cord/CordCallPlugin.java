package tech.nikg.cord;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Мост «страница ↔ разговор в системе» — {@code window.Capacitor} → {@code CordCall}.
 *
 * <p>Страница (web/src/core/mobile-app.ts) зовёт {@code start({title, microphone})} при входе во
 * встречу и на каждое изменение названия или микрофона, {@code stop()} — при выходе. Обратно идёт
 * событие {@code command} с {@code action: "hangup" | "microphone"} — нажатия в уведомлении.
 *
 * <p>Доступ к микрофону страница получает раньше, через запрос WebView (Capacitor сам спрашивает
 * {@code RECORD_AUDIO}). Без него служба с типом {@code microphone} на Android 14 не стартует —
 * тогда {@code start} отвечает ошибкой, и разговор идёт как в браузере. Разрешение на уведомления
 * (Android 13+) спрашивается здесь: без него служба работает, но уведомления не видно.
 */
@CapacitorPlugin(
    name = "CordCall",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class CordCallPlugin extends Plugin {

    /** Идёт ли разговор — для «картинки в картинке» при уходе из приложения ({@link MainActivity}). */
    private static volatile boolean active = false;

    public static boolean active() {
        return active;
    }

    /** Разрешение на уведомления спрашиваем один раз за запуск, а не на каждое обновление. */
    private boolean askedNotifications = false;

    @Override
    public void load() {
        CallService.setCommands((action) -> {
            JSObject data = new JSObject();
            data.put("action", action);
            notifyListeners("command", data, true);
        });
    }

    @Override
    protected void handleOnDestroy() {
        CallService.setCommands(null);
        super.handleOnDestroy();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            call.reject("microphone permission missing", "NO_MICROPHONE");
            return;
        }
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !askedNotifications &&
            getPermissionState("notifications") != PermissionState.GRANTED
        ) {
            // Ответ на разговор не влияет — служба поднимется в любом случае, только без видимого уведомления.
            askedNotifications = true;
            requestPermissionForAlias("notifications", call, "notificationsAnswered");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void notificationsAnswered(PluginCall call) {
        begin(call);
    }

    private void begin(PluginCall call) {
        String title = call.getString("title", getContext().getString(R.string.call_default_title));
        boolean microphone = Boolean.TRUE.equals(call.getBoolean("microphone", true));
        try {
            CallService.start(getContext(), title, microphone);
            active = true;
            MainActivity.callChanged(getActivity(), true);
            call.resolve();
        } catch (RuntimeException error) {
            // Android 12+: службу нельзя поднять из фона (ForegroundServiceStartNotAllowedException).
            call.reject("call service refused: " + error.getMessage(), "REFUSED");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        active = false;
        CallService.stop(getContext());
        MainActivity.callChanged(getActivity(), false);
        call.resolve();
    }
}
