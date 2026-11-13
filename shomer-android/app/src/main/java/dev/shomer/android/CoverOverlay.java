package dev.shomer.android;

import android.content.Context;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * Draws opaque covers above every app with one small overlay window per cover. Separate windows
 * (instead of one full-screen window) matter: since Android 12 a full-screen opaque overlay from
 * another app would block every touch on the phone. Touches only stop working on the covered areas.
 * Main thread only.
 */
final class CoverOverlay {
    private static final int COVER_COLOR = Color.rgb(96, 104, 116);

    private final Context context;
    private final WindowManager windows;
    private final List<View> views = new ArrayList<>();

    CoverOverlay(Context context) {
        this.context = context;
        this.windows = context.getSystemService(WindowManager.class);
    }

    static boolean allowed(Context context) { return Settings.canDrawOverlays(context); }

    /** Shows exactly these rectangles (screen pixels); reuses, moves or removes existing windows. */
    void show(List<Rect> rects) {
        int i = 0;
        for (Rect r : rects) {
            if (r.width() <= 0 || r.height() <= 0) continue;
            WindowManager.LayoutParams params = params(r);
            try {
                if (i < views.size()) {
                    windows.updateViewLayout(views.get(i), params);
                } else {
                    View view = newCover();
                    windows.addView(view, params);
                    views.add(view);
                }
                i++;
            } catch (RuntimeException failure) {
                // Permission revoked or window rejected; the service reports it on the next frame.
            }
        }
        while (views.size() > i) remove(views.remove(views.size() - 1));
    }

    void clear() {
        for (View view : views) remove(view);
        views.clear();
    }

    int count() { return views.size(); }

    private void remove(View view) {
        try {
            windows.removeViewImmediate(view);
        } catch (RuntimeException alreadyGone) {
            // Ignore.
        }
    }

    private View newCover() {
        TextView view = new TextView(context);
        view.setBackgroundColor(COVER_COLOR);
        view.setTextColor(Color.argb(160, 255, 255, 255));
        view.setGravity(Gravity.CENTER);
        view.setText("Shomer");
        view.setTextSize(12);
        return view;
    }

    @SuppressWarnings("deprecation")
    private static WindowManager.LayoutParams params(Rect r) {
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
            r.width(), r.height(),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.OPAQUE);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = r.left;
        params.y = r.top;
        params.setTitle("Shomer cover");
        if (Build.VERSION.SDK_INT >= 28) {
            params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        if (Build.VERSION.SDK_INT >= 30) params.setFitInsetsTypes(0);
        return params;
    }
}
