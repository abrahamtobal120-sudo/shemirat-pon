package dev.shomer.android;

import android.app.*;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.hardware.display.*;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.*;
import android.os.*;
import android.util.DisplayMetrics;

public class CaptureService extends Service {
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread thread;
    private boolean started;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "STOP".equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (started) return START_NOT_STICKY;
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel("capture", "Captura de prueba", NotificationManager.IMPORTANCE_LOW));
        PendingIntent stop = PendingIntent.getService(this, 0,
            new Intent(this, CaptureService.class).setAction("STOP"),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notice = new Notification.Builder(this, "capture")
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("Shomer — captura de prueba")
            .setContentText("Filtrado pendiente. Puedes detener la captura.")
            .setOngoing(true).addAction(android.R.drawable.ic_media_pause, "Detener", stop).build();
        startForeground(1, notice);
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        try {
            Intent consent = intent.getParcelableExtra("consent");
            if (consent == null) { stopSelf(); return START_NOT_STICKY; }
            thread = new HandlerThread("ShomerCapture");
            thread.start();
            Handler handler = new Handler(thread.getLooper());
            projection = getSystemService(MediaProjectionManager.class).getMediaProjection(
                intent.getIntExtra("result", Activity.RESULT_CANCELED), consent);
            projection.registerCallback(new MediaProjection.Callback() {
                @Override public void onStop() { stopSelf(); }
                @Override public void onCapturedContentResize(int width, int height) {
                    // A new consent session is required for this prototype after rotation.
                    stopSelf();
                }
            }, handler);
            DisplayMetrics metrics = getResources().getDisplayMetrics();
            reader = ImageReader.newInstance(metrics.widthPixels, metrics.heightPixels, PixelFormat.RGBA_8888, 2);
            reader.setOnImageAvailableListener(source -> {
                try (Image image = source.acquireLatestImage()) {
                    // Frames stay in memory. Native inference will be integrated here.
                } catch (IllegalStateException ignored) {
                    // The reader may close while the system revokes capture.
                }
            }, handler);
            display = projection.createVirtualDisplay("ShomerCapture", metrics.widthPixels,
                metrics.heightPixels, metrics.densityDpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                reader.getSurface(), null, handler);
            started = true;
        } catch (RuntimeException failure) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        if (display != null) display.release();
        if (reader != null) reader.close();
        if (projection != null) projection.stop();
        if (thread != null) thread.quitSafely();
        stopForeground(true);
        super.onDestroy();
    }
}
