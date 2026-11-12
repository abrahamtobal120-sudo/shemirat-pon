package dev.shomer.android;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final int CAPTURE_REQUEST = 10;
    private static final int NOTIFICATION_REQUEST = 11;
    private TextView status;
    private TextView notificationStatus;
    private Button start;
    private Button stop;
    private boolean consentPending;

    private final BroadcastReceiver statusReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) { refresh(); }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (state != null) consentPending = state.getBoolean("consentPending");
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(32, 56, 32, 32);
        TextView text = new TextView(this);
        text.setText("Shomer Android — prueba de captura\n\nNo filtra ni cubre contenido: los cuadros se descartan en memoria. Las pantallas protegidas pueden no ser capturables. El consentimiento es necesario para cada sesión.");
        layout.addView(text);
        status = new TextView(this);
        layout.addView(status);
        notificationStatus = new TextView(this);
        layout.addView(notificationStatus);
        Button notifications = new Button(this);
        notifications.setText("Permitir notificaciones");
        notifications.setOnClickListener(view -> {
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
            }
        });
        if (Build.VERSION.SDK_INT >= 33) layout.addView(notifications);
        start = new Button(this);
        start.setText("Autorizar captura de prueba");
        start.setOnClickListener(view -> {
            try {
                consentPending = true;
                refresh();
                startActivityForResult(getSystemService(MediaProjectionManager.class).createScreenCaptureIntent(), CAPTURE_REQUEST);
            } catch (RuntimeException failure) {
                consentPending = false;
                CaptureService.report(this, "No se pudo abrir la autorización (" + failure.getClass().getSimpleName() + ").");
                refresh();
            }
        });
        layout.addView(start);
        stop = new Button(this);
        stop.setText("Detener captura");
        stop.setOnClickListener(view -> stopService(new Intent(this, CaptureService.class)));
        layout.addView(stop);
        setContentView(layout);
        refresh();
    }

    @Override protected void onStart() {
        super.onStart();
        IntentFilter filter = new IntentFilter(CaptureService.ACTION_STATUS);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(statusReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(statusReceiver, filter);
        refresh();
    }

    @Override protected void onResume() {
        super.onResume();
        refresh();
    }

    @Override protected void onStop() {
        unregisterReceiver(statusReceiver);
        super.onStop();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putBoolean("consentPending", consentPending);
        super.onSaveInstanceState(state);
    }

    private void refresh() {
        status.setText("Estado: " + CaptureService.getStatus());
        NotificationManager manager = getSystemService(NotificationManager.class);
        NotificationChannel channel = manager.getNotificationChannel("capture");
        boolean enabled = manager.areNotificationsEnabled()
            && (channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE);
        notificationStatus.setText(enabled ? "Notificaciones habilitadas." :
            "Notificaciones deshabilitadas: el control podría no aparecer en el panel. Puedes detener desde esta app o los controles del sistema.");
        start.setEnabled(!CaptureService.isActive() && !consentPending);
        stop.setEnabled(CaptureService.isActive());
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != CAPTURE_REQUEST) return;
        consentPending = false;
        if (result != RESULT_OK || data == null) {
            CaptureService.report(this, "Autorización cancelada o denegada; no se inició la captura.");
        } else {
            try {
                Intent service = new Intent(this, CaptureService.class);
                service.putExtra("result", result);
                service.putExtra("consent", data);
                startForegroundService(service);
            } catch (RuntimeException failure) {
                CaptureService.report(this, "No se pudo iniciar el servicio (" + failure.getClass().getSimpleName() + ").");
            }
        }
        refresh();
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == NOTIFICATION_REQUEST) refresh();
    }
}
