package dev.shomer.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Turns the filter back on after the phone restarts or Shomer is updated, if it was on before. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            FilterVpnService.resumeIfEnabled(context);
        }
    }
}
