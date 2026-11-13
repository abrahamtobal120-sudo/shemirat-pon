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
import android.net.VpnService;
import android.provider.Settings;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.os.Build;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private static final int CAPTURE_REQUEST = 10;
    private static final int NOTIFICATION_REQUEST = 11;
    private static final int VPN_REQUEST = 12;
    private TextView filterStatus;
    private RadioButton wholePhone;
    private RadioButton browsersOnly;
    private Button filterStart;
    private Button filterStop;
    private final android.os.Handler ticker = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override public void run() { refresh(); ticker.postDelayed(this, 2000); }
    };
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
        buildFilterSection(layout);
        TextView text = new TextView(this);
        text.setPadding(0, 48, 0, 0);
        text.setText("Prueba experimental: filtro visual por captura de pantalla\n\nTodavía no cubre imágenes: los cuadros se descartan en memoria. Las pantallas protegidas pueden no ser capturables. El consentimiento es necesario para cada sesión.");
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
        ScrollView scroll = new ScrollView(this);
        scroll.addView(layout);
        setContentView(scroll);
        refresh();
    }

    private void buildFilterSection(LinearLayout layout) {
        TextView title = new TextView(this);
        title.setTextSize(22);
        title.setText("Shomer — filtro");
        layout.addView(title);
        TextView about = new TextView(this);
        about.setText("Bloquea sitios para adultos y publicidad mediante un filtro DNS local (VPN de Shomer). "
            + "Las consultas permitidas se resuelven con CleanBrowsing Family, que además fuerza la búsqueda segura de Google, Bing y YouTube. "
            + "El resto del tráfico no pasa por Shomer y no se guarda historial. No analiza imágenes dentro de otras apps.\n\n¿Dónde quieres filtrar?");
        layout.addView(about);
        RadioGroup scope = new RadioGroup(this);
        wholePhone = new RadioButton(this);
        wholePhone.setId(android.view.View.generateViewId());
        wholePhone.setText("Todo el teléfono (todas las apps)");
        browsersOnly = new RadioButton(this);
        browsersOnly.setId(android.view.View.generateViewId());
        browsersOnly.setText("Solo navegadores (Chrome, Firefox, Samsung Internet…)");
        scope.addView(wholePhone);
        scope.addView(browsersOnly);
        boolean browsers = FilterVpnService.SCOPE_BROWSERS.equals(
            FilterVpnService.prefs(this).getString(FilterVpnService.PREF_SCOPE, FilterVpnService.SCOPE_PHONE));
        scope.check(browsers ? browsersOnly.getId() : wholePhone.getId());
        layout.addView(scope);
        filterStart = new Button(this);
        filterStart.setText("Activar filtro");
        filterStart.setOnClickListener(view -> {
            Intent consent = VpnService.prepare(this);
            if (consent == null) startFilter();
            else startActivityForResult(consent, VPN_REQUEST);
        });
        layout.addView(filterStart);
        filterStop = new Button(this);
        filterStop.setText("Detener filtro");
        filterStop.setOnClickListener(view -> startService(new Intent(this, FilterVpnService.class).setAction(FilterVpnService.ACTION_STOP)));
        layout.addView(filterStop);
        Button always = new Button(this);
        always.setText("Hacerlo permanente (VPN siempre activa)");
        always.setOnClickListener(view -> {
            try {
                startActivity(new Intent(Settings.ACTION_VPN_SETTINGS));
            } catch (RuntimeException missing) {
                startActivity(new Intent(Settings.ACTION_WIRELESS_SETTINGS));
            }
        });
        layout.addView(always);
        TextView tip = new TextView(this);
        tip.setText("Para que no se pueda saltar: en Ajustes › VPN › Shomer activa «VPN siempre activa» y «Bloquear conexiones sin VPN». "
            + "Si «DNS privado» tiene un nombre de proveedor, cámbialo a «Automático» o «Desactivado». Solo puede haber una VPN activa a la vez.");
        layout.addView(tip);
        filterStatus = new TextView(this);
        filterStatus.setPadding(0, 16, 0, 0);
        layout.addView(filterStatus);
    }

    private void startFilter() {
        String scope = browsersOnly.isChecked() ? FilterVpnService.SCOPE_BROWSERS : FilterVpnService.SCOPE_PHONE;
        try {
            startService(new Intent(this, FilterVpnService.class)
                .setAction(FilterVpnService.ACTION_START)
                .putExtra(FilterVpnService.PREF_SCOPE, scope));
        } catch (RuntimeException failure) {
            filterStatus.setText("No se pudo iniciar el filtro (" + failure.getClass().getSimpleName() + ").");
        }
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
        ticker.post(tick);
    }

    @Override protected void onPause() {
        ticker.removeCallbacks(tick);
        super.onPause();
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
        if (filterStatus != null) {
            boolean on = FilterVpnService.isRunning();
            filterStatus.setText("Estado del filtro: " + FilterVpnService.getStatus()
                + (on ? "\nConsultas revisadas: " + FilterVpnService.getQueries() + " · bloqueadas: " + FilterVpnService.getBlocked() : ""));
            filterStart.setText(on ? "Aplicar cambio de modo" : "Activar filtro");
            filterStop.setEnabled(on);
        }
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
        if (request == VPN_REQUEST) {
            if (result == RESULT_OK) startFilter();
            else filterStatus.setText("No se autorizó la VPN de Shomer; el filtro no está activo.");
            return;
        }
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
