package tech.nikg.cord;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import androidx.annotation.Nullable;
import com.getcapacitor.BridgeActivity;

/**
 * Окно Cord: WebView со страницей сервера (`server.url` в capacitor.config.json).
 *
 * <p>Своё здесь — плагин разговора ({@link CordCallPlugin}) и «картинка в картинке» всего окна:
 * пока идёт разговор, уход «Домой» сворачивает приложение в окно поверх других (Android 12+ — сам,
 * через {@code setAutoEnterEnabled}; Android 8–11 — из {@link #onUserLeaveHint()}). Страница в окне
 * остаётся видимой, поэтому и камера не гаснет.
 */
public class MainActivity extends BridgeActivity {

    /** Вертикальный кадр, как у телефона в руке. */
    private static final Rational ASPECT = new Rational(9, 16);

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CordCallPlugin.class);
        super.onCreate(savedInstanceState);
    }

    /** Разговор начался или кончился — с этим меняется и поведение при уходе «Домой». */
    static void callChanged(@Nullable Activity activity, boolean inCall) {
        if (!(activity instanceof MainActivity) || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        MainActivity main = (MainActivity) activity;
        main.runOnUiThread(() -> main.updatePictureInPicture(inCall));
    }

    private void updatePictureInPicture(boolean inCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        PictureInPictureParams.Builder builder = new PictureInPictureParams.Builder().setAspectRatio(ASPECT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setAutoEnterEnabled(inCall);
        try {
            setPictureInPictureParams(builder.build());
        } catch (IllegalStateException ignored) {
            // Окно без поддержки PiP (например, в режиме нескольких окон у некоторых производителей).
        }
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return;
        if (!CordCallPlugin.active()) return;
        try {
            enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(ASPECT).build());
        } catch (IllegalStateException ignored) {
            // Нельзя — значит, приложение просто уйдёт в фон; разговор держит служба.
        }
    }
}
