package dev.shomer.android;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
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
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Display;
import android.view.WindowManager;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * Whole-phone image filter: mirrors the screen into a small private virtual display, detects people
 * on the device (YOLO + gender model, as in Shomer Web) and draws opaque covers over the women it
 * finds, above every app. Frames stay in memory and are never saved or sent.
 *
 * Threads: capture, inference and the tracker run on {@link #worker}; overlay windows on the main thread.
 */
public class CaptureService extends Service {
    static final String ACTION_STOP = "dev.shomer.android.STOP";
    static final String ACTION_STATUS = "dev.shomer.android.STATUS";
    /** Long side of the analysed frame; smaller is faster, larger finds smaller people. */
    private static final int CAPTURE_LONG_SIDE = 960;
    private static final long MIN_INTERVAL_MS = 250;

    private static volatile String status = "Detenido";
    private static volatile boolean active;

    private final Handler main = new Handler(Looper.getMainLooper());
    private HandlerThread workerThread;
    private Handler worker;

    // Worker-thread state.
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private DisplayManager displayManager;
    private ScreenDetector detector;
    private final CoverTracker tracker = new CoverTracker();
    private int densityDpi;
    private int screenW, screenH;
    private boolean analysisScheduled;
    private long lastAnalysis;
    private Bitmap raw;
    private ByteBuffer scratch;
    private int lastReportedCovers = -1;
    private final int[] gridPixels = new int[CoverTracker.GRID_W * CoverTracker.GRID_H];

    // Main-thread state.
    private CoverOverlay overlay;

    private volatile boolean terminalStatus;
    private volatile boolean failed;

    static String getStatus() { return status; }
    static boolean isActive() { return active; }

    static void report(Context context, String message) {
        status = message;
        context.sendBroadcast(new Intent(ACTION_STATUS).setPackage(context.getPackageName()));
    }

    private final MediaProjection.Callback projectionCallback = new MediaProjection.Callback() {
        @Override public void onStop() {
            fail("La captura terminó o fue revocada por el sistema. Vuelve a activar el filtro.");
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
            report(this, "Detenido por el usuario");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (active) return START_NOT_STICKY;
        active = true;
        report(this, "Iniciando…");
        try {
            NotificationManager notifications = getSystemService(NotificationManager.class);
            notifications.createNotificationChannel(new NotificationChannel(
                "capture", "Filtro de imágenes", NotificationManager.IMPORTANCE_LOW));
            PendingIntent stop = PendingIntent.getService(this, 0,
                new Intent(this, CaptureService.class).setAction(ACTION_STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
            Notification notice = new Notification.Builder(this, "capture")
                .setSmallIcon(android.R.drawable.ic_menu_view)
                .setContentTitle("Shomer — filtro de imágenes activo")
                .setContentText("Cubre a las personas en pantalla. Toca para abrir o detener.")
                .setContentIntent(open).setOngoing(true)
                .addAction(android.R.drawable.ic_media_pause, "Detener", stop).build();
            startForeground(1, notice);
        } catch (RuntimeException failure) {
            fail("No se pudo iniciar el servicio (" + failure.getClass().getSimpleName() + ").");
            return START_NOT_STICKY;
        }
        if (!CoverOverlay.allowed(this)) {
            fail("Falta el permiso «Mostrar sobre otras apps». Concédelo y vuelve a activar el filtro.");
            return START_NOT_STICKY;
        }
        overlay = new CoverOverlay(this);
        Intent consent = intent == null ? null : intent.getParcelableExtra("consent");
        int result = intent == null ? Activity.RESULT_CANCELED : intent.getIntExtra("result", Activity.RESULT_CANCELED);
        if (result != Activity.RESULT_OK || consent == null) {
            fail("No se recibió una autorización válida. Vuelve a activar el filtro.");
            return START_NOT_STICKY;
        }
        workerThread = new HandlerThread("ShomerScreenFilter");
        workerThread.start();
        worker = new Handler(workerThread.getLooper());
        worker.post(() -> setUp(result, consent));
        return START_NOT_STICKY;
    }

    /** Worker thread. */
    private void setUp(int result, Intent consent) {
        try {
            projection = getSystemService(MediaProjectionManager.class).getMediaProjection(result, consent);
            if (projection == null) throw new IllegalStateException("MediaProjection no disponible");
            projection.registerCallback(projectionCallback, worker);
            DisplayMetrics metrics = realDisplayMetrics();
            densityDpi = metrics.densityDpi;
            int width = metrics.widthPixels, height = metrics.heightPixels;
            if (Build.VERSION.SDK_INT >= 30) {
                Rect bounds = getSystemService(WindowManager.class).getMaximumWindowMetrics().getBounds();
                width = bounds.width();
                height = bounds.height();
            }
            screenW = width;
            screenH = height;
            int[] size = captureSize(width, height);
            reader = newReader(size[0], size[1]);
            // Create the virtual display right away: on Android 14+ the consent expires if it waits.
            display = projection.createVirtualDisplay("ShomerFilter", size[0], size[1], captureDpi(width, size[0]),
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, worker);
            if (display == null) throw new IllegalStateException("No se pudo crear la pantalla virtual");
            if (Build.VERSION.SDK_INT < 34) {
                displayManager = getSystemService(DisplayManager.class);
                displayManager.registerDisplayListener(displayListener, worker);
            }
            report(this, "Cargando el modelo de detección…");
            detector = ScreenDetector.load(this);
            report(this, detector.hasGenderModel()
                ? "Filtro activo: cubre a las mujeres que aparecen en pantalla."
                : "Filtro activo (sin modelo de género): cubre a todas las personas.");
            scheduleAnalysis();
        } catch (Exception failure) {
            fail("No se pudo iniciar el filtro (" + failure.getClass().getSimpleName() + "). Vuelve a activarlo.");
        }
    }

    @SuppressWarnings("deprecation")
    private DisplayMetrics realDisplayMetrics() {
        DisplayMetrics metrics = new DisplayMetrics();
        getSystemService(WindowManager.class).getDefaultDisplay().getRealMetrics(metrics);
        return metrics;
    }

    private static int[] captureSize(int width, int height) {
        float scale = Math.min(1f, CAPTURE_LONG_SIDE / (float) Math.max(width, height));
        int w = Math.max(2, Math.round(width * scale) & ~1);
        int h = Math.max(2, Math.round(height * scale) & ~1);
        return new int[]{w, h};
    }

    private int captureDpi(int screenWidth, int captureWidth) {
        return Math.max(1, Math.round(densityDpi * captureWidth / (float) screenWidth));
    }

    private ImageReader newReader(int width, int height) {
        ImageReader next = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        next.setOnImageAvailableListener(source -> {
            if (!terminalStatus && source == reader && detector != null) scheduleAnalysis();
        }, worker);
        return next;
    }

    /** Worker thread. Coalesces new-frame events and limits analysis to one every MIN_INTERVAL_MS. */
    private void scheduleAnalysis() {
        if (analysisScheduled || terminalStatus) return;
        analysisScheduled = true;
        long wait = Math.max(0, lastAnalysis + MIN_INTERVAL_MS - SystemClock.uptimeMillis());
        worker.postDelayed(this::analyzeLatest, wait);
    }

    /** Worker thread. */
    private void analyzeLatest() {
        analysisScheduled = false;
        if (terminalStatus || reader == null || detector == null) return;
        Bitmap frame;
        try (Image image = reader.acquireLatestImage()) {
            if (image == null) return;
            frame = toBitmap(image);
        } catch (RuntimeException failure) {
            fail("Error al recibir la pantalla (" + failure.getClass().getSimpleName() + ").");
            return;
        }
        lastAnalysis = SystemClock.uptimeMillis();
        try {
            List<YoloDecoder.Box> detections = detector.analyze(frame);
            if (tracker.update(luminanceGrid(frame), detections)) {
                // The overlay change produces a new frame: analyse it promptly.
                lastAnalysis = 0;
                publishCovers(tracker.covers());
            }
        } catch (Exception failure) {
            // In doubt keep the current covers and try again on the next frame.
        } finally {
            if (frame != raw) frame.recycle();
        }
    }

    private Bitmap toBitmap(Image image) {
        Image.Plane plane = image.getPlanes()[0];
        int width = image.getWidth(), height = image.getHeight();
        int pixelStride = plane.getPixelStride(), rowStride = plane.getRowStride();
        int stridePixels = rowStride / pixelStride;
        if (raw == null || raw.getWidth() != stridePixels || raw.getHeight() != height) {
            if (raw != null) raw.recycle();
            raw = Bitmap.createBitmap(stridePixels, height, Bitmap.Config.ARGB_8888);
        }
        ByteBuffer buffer = plane.getBuffer();
        buffer.rewind();
        int needed = stridePixels * height * 4;
        if (buffer.remaining() >= needed) {
            raw.copyPixelsFromBuffer(buffer);
        } else {
            // The last row is often not padded to rowStride: copy into a full-size buffer.
            if (scratch == null || scratch.capacity() < needed) scratch = ByteBuffer.allocateDirect(needed);
            scratch.clear();
            scratch.put(buffer);
            while (scratch.position() < needed) scratch.put((byte) 0);
            scratch.flip();
            raw.copyPixelsFromBuffer(scratch);
        }
        return stridePixels == width ? raw : Bitmap.createBitmap(raw, 0, 0, width, height);
    }

    private float[] luminanceGrid(Bitmap frame) {
        Bitmap small = Bitmap.createScaledBitmap(frame, CoverTracker.GRID_W, CoverTracker.GRID_H, true);
        small.getPixels(gridPixels, 0, CoverTracker.GRID_W, 0, 0, CoverTracker.GRID_W, CoverTracker.GRID_H);
        if (small != frame) small.recycle();
        float[] grid = new float[gridPixels.length];
        for (int i = 0; i < grid.length; i++) {
            int c = gridPixels[i];
            grid[i] = 0.299f * ((c >> 16) & 0xFF) + 0.587f * ((c >> 8) & 0xFF) + 0.114f * (c & 0xFF);
        }
        return grid;
    }

    /** Worker thread → main thread. */
    private void publishCovers(List<YoloDecoder.Box> covers) {
        int w = screenW, h = screenH;
        List<Rect> rects = new ArrayList<>(covers.size());
        for (YoloDecoder.Box b : covers) {
            rects.add(new Rect(Math.round(b.x1 * w), Math.round(b.y1 * h), Math.round(b.x2 * w), Math.round(b.y2 * h)));
        }
        main.post(() -> {
            if (terminalStatus || overlay == null) return;
            overlay.show(rects);
            if (rects.size() != lastReportedCovers) {
                lastReportedCovers = rects.size();
                report(this, rects.isEmpty()
                    ? "Filtro activo: nada que cubrir en pantalla."
                    : "Filtro activo: " + rects.size() + " zona(s) cubierta(s).");
            }
        });
    }

    /** Worker thread. {@code width}/{@code height} are screen pixels. */
    private void resizeCapture(int width, int height) {
        if (width <= 0 || height <= 0) {
            fail("El sistema informó un tamaño de pantalla inválido.");
            return;
        }
        if (width == screenW && height == screenH && reader != null) return;
        int[] size = captureSize(width, height);
        ImageReader next = null;
        try {
            next = newReader(size[0], size[1]);
            display.setSurface(null);
            display.resize(size[0], size[1], captureDpi(width, size[0]));
            display.setSurface(next.getSurface());
            ImageReader previous = reader;
            reader = next;
            screenW = width;
            screenH = height;
            if (previous != null) {
                previous.setOnImageAvailableListener(null, null);
                previous.close();
            }
            // Rotation or resize: old covers no longer match the screen.
            tracker.clear();
            lastAnalysis = 0;
            publishCovers(new ArrayList<>());
        } catch (RuntimeException failure) {
            if (next != null && next != reader) next.close();
            fail("No se pudo adaptar la captura al giro de pantalla (" + failure.getClass().getSimpleName() + ").");
        }
    }

    private void fail(String message) {
        if (terminalStatus) return;
        terminalStatus = true;
        failed = true;
        report(this, message);
        stopSelf();
    }

    @Override public void onDestroy() {
        terminalStatus = true;
        if (overlay != null) overlay.clear();
        if (worker != null) {
            worker.removeCallbacksAndMessages(null);
            worker.post(this::releaseCapture);
            workerThread.quitSafely();
        }
        active = false;
        if (!failed) report(this, "Detenido por el usuario");
        else sendBroadcast(new Intent(ACTION_STATUS).setPackage(getPackageName()));
        stopForeground(true);
        super.onDestroy();
    }

    /** Worker thread. */
    private void releaseCapture() {
        if (displayManager != null) displayManager.unregisterDisplayListener(displayListener);
        if (projection != null) projection.unregisterCallback(projectionCallback);
        if (display != null) display.release();
        if (reader != null) {
            reader.setOnImageAvailableListener(null, null);
            reader.close();
        }
        if (projection != null) projection.stop();
        if (detector != null) detector.close();
        if (raw != null) raw.recycle();
        display = null;
        reader = null;
        projection = null;
        detector = null;
        raw = null;
    }
}
