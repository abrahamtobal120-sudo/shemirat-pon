package dev.shomer.android;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.WindowManager;

public class CaptureService extends Service {
    static final String ACTION_STOP = "dev.shomer.android.STOP";
    static final String ACTION_STATUS = "dev.shomer.android.STATUS";
    private static String status = "Detenida";
    private static boolean active;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private DisplayManager displayManager;
    private int densityDpi;
    private boolean terminalStatus;
    private boolean receivedFrame;

    static String getStatus() { return status; }
    static boolean isActive() { return active; }

    static void report(Context context, String message) {
        status = message;
        context.sendBroadcast(new Intent(ACTION_STATUS).setPackage(context.getPackageName()));
    }

    private final MediaProjection.Callback projectionCallback = new MediaProjection.Callback() {
        @Override public void onStop() {
            fail("La captura terminó o fue revocada por el sistema. Autoriza una sesión nueva.");
        }

        @Override public void onCapturedContentResize(int width, int height) {
            if (!terminalStatus && display != null) resizeCapture(width, height);
        }
    };

    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override public void onDisplayAdded(int id) { }
        @Override public void onDisplayRemoved(int id) { }
        @Override public void onDisplayChanged(int id) {
            if (!terminalStatus && id == Display.DEFAULT_DISPLAY && display != null) {
                try {
                    DisplayMetrics metrics = realDisplayMetrics();
                    densityDpi = metrics.densityDpi;
                    resizeCapture(metrics.widthPixels, metrics.heightPixels);
                } catch (RuntimeException failure) {
                    fail("No se pudo consultar la pantalla (" + failure.getClass().getSimpleName() + ").");
                }
            }
        }
    };

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            terminalStatus = true;
            report(this, "Detenida por el usuario");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (active) return START_NOT_STICKY;
        active = true;
        report(this, "Iniciando captura autorizada…");
        try {
            NotificationManager notifications = getSystemService(NotificationManager.class);
            notifications.createNotificationChannel(new NotificationChannel(
                "capture", "Captura de prueba", NotificationManager.IMPORTANCE_LOW));
            PendingIntent stop = PendingIntent.getService(this, 0,
                new Intent(this, CaptureService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification notice = new Notification.Builder(this, "capture")
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("Shomer — captura de prueba")
                .setContentText("Sin filtro visual. Toca para abrir o detener.")
                .setContentIntent(open).setOngoing(true)
                .addAction(android.R.drawable.ic_media_pause, "Detener", stop).build();
            startForeground(1, notice);
            Intent consent = intent == null ? null : intent.getParcelableExtra("consent");
            int result = intent == null ? Activity.RESULT_CANCELED : intent.getIntExtra("result", Activity.RESULT_CANCELED);
            if (result != Activity.RESULT_OK || consent == null) {
                fail("No se recibió una autorización válida. Inicia una sesión nueva.");
                return START_NOT_STICKY;
            }
            projection = getSystemService(MediaProjectionManager.class).getMediaProjection(result, consent);
            if (projection == null) throw new IllegalStateException("MediaProjection no disponible");
            projection.registerCallback(projectionCallback, handler);
            DisplayMetrics metrics = realDisplayMetrics();
            densityDpi = metrics.densityDpi;
            int width = metrics.widthPixels, height = metrics.heightPixels;
            if (Build.VERSION.SDK_INT >= 30) {
                Rect bounds = getSystemService(WindowManager.class).getMaximumWindowMetrics().getBounds();
                width = bounds.width();
                height = bounds.height();
            }
            reader = newReader(width, height);
            display = projection.createVirtualDisplay("ShomerCapture", width, height, densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler);
            if (display == null) throw new IllegalStateException("No se pudo crear la pantalla virtual");
            if (Build.VERSION.SDK_INT < 34) {
                displayManager = getSystemService(DisplayManager.class);
                displayManager.registerDisplayListener(displayListener, handler);
            }
            report(this, "Captura iniciada; esperando el primer cuadro. Sin filtro visual.");
        } catch (RuntimeException failure) {
            fail("No se pudo iniciar la captura (" + failure.getClass().getSimpleName() + "). Autoriza una sesión nueva.");
        }
        return START_NOT_STICKY;
    }

    @SuppressWarnings("deprecation")
    private DisplayMetrics realDisplayMetrics() {
        DisplayMetrics metrics = new DisplayMetrics();
        getSystemService(WindowManager.class).getDefaultDisplay().getRealMetrics(metrics);
        return metrics;
    }

    private ImageReader newReader(int width, int height) {
        ImageReader next = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        next.setOnImageAvailableListener(source -> {
            if (terminalStatus || source != reader) return;
            try (Image image = source.acquireLatestImage()) {
                if (image != null && !receivedFrame) {
                    receivedFrame = true;
                    report(this, "Recibiendo cuadros; se descartan. Sin inferencia ni filtro visual.");
                }
            } catch (RuntimeException failure) {
                fail("Error al recibir cuadros (" + failure.getClass().getSimpleName() + ").");
            }
        }, handler);
        return next;
    }

    private void resizeCapture(int width, int height) {
        if (width <= 0 || height <= 0) {
            fail("El sistema informó un tamaño de captura inválido.");
            return;
        }
        if (reader != null && reader.getWidth() == width && reader.getHeight() == height) return;
        ImageReader next = null;
        try {
            next = newReader(width, height);
            display.setSurface(null);
            display.resize(width, height, densityDpi);
            display.setSurface(next.getSurface());
            ImageReader previous = reader;
            reader = next;
            if (previous != null) {
                previous.setOnImageAvailableListener(null, null);
                previous.close();
            }
            receivedFrame = false;
            report(this, "Captura redimensionada; esperando un cuadro. Sin filtro visual.");
        } catch (RuntimeException failure) {
            if (next != null && next != reader) next.close();
            fail("No se pudo redimensionar la captura (" + failure.getClass().getSimpleName() + ").");
        }
    }

    private void fail(String message) {
        if (terminalStatus) return;
        terminalStatus = true;
        report(this, message);
        stopSelf();
    }

    @Override public void onDestroy() {
        if (displayManager != null) displayManager.unregisterDisplayListener(displayListener);
        if (projection != null) projection.unregisterCallback(projectionCallback);
        if (display != null) display.release();
        if (reader != null) {
            reader.setOnImageAvailableListener(null, null);
            reader.close();
        }
        if (projection != null) projection.stop();
        active = false;
        if (!terminalStatus) report(this, "Detenida por el usuario");
        else sendBroadcast(new Intent(ACTION_STATUS).setPackage(getPackageName()));
        stopForeground(true);
        super.onDestroy();
    }
}
