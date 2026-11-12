package dev.shomer.android;

import android.app.Activity;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(32, 56, 32, 32);
        TextView text = new TextView(this);
        text.setText("Shomer Android — prueba de captura\n\nEsta versión comprueba el permiso para leer la pantalla. El filtrado visual sigue pendiente. Las capturas se descartan en memoria.");
        layout.addView(text);
        Button start = new Button(this);
        start.setText("Autorizar captura de prueba");
        start.setOnClickListener(view -> {
            MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
            startActivityForResult(manager.createScreenCaptureIntent(), 10);
        });
        layout.addView(start);
        Button stop = new Button(this);
        stop.setText("Detener captura");
        stop.setOnClickListener(view -> stopService(new Intent(this, CaptureService.class)));
        layout.addView(stop);
        setContentView(layout);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 10 && result == RESULT_OK && data != null) {
            Intent service = new Intent(this, CaptureService.class);
            service.putExtra("result", result);
            service.putExtra("consent", data);
            startForegroundService(service);
        }
    }
}
