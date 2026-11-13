package dev.shomer.android;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;

import java.io.BufferedReader;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Local DNS-only VPN. Apps inside the VPN resolve names through Shomer: blocked names get NXDOMAIN
 * and the rest are forwarded to family-filter DNS resolvers (which also block adult sites and
 * enforce SafeSearch). No other traffic passes through the VPN, and nothing is recorded.
 */
public class FilterVpnService extends VpnService {
    static final String ACTION_START = "dev.shomer.android.FILTER_START";
    static final String ACTION_STOP = "dev.shomer.android.FILTER_STOP";
    static final String SCOPE_PHONE = "phone";
    static final String SCOPE_BROWSERS = "browsers";
    static final String PREFS = "shomer";
    static final String PREF_SCOPE = "scope";
    static final String PREF_ENABLED = "filterEnabled";

    private static final String TUN_ADDRESS = "10.111.222.1";
    private static final String DNS_ADDRESS = "10.111.222.2";
    /** CleanBrowsing Family (blocks adult content, enforces SafeSearch), then Cloudflare Families. */
    private static final String[] UPSTREAM = {"185.228.168.168", "185.228.169.168", "1.1.1.3", "1.0.0.3"};
    /** Common browsers, added in browser-only mode even if the system does not list them. */
    private static final String[] KNOWN_BROWSERS = {
        "com.android.chrome", "com.chrome.beta", "org.mozilla.firefox", "org.mozilla.firefox_beta",
        "org.mozilla.focus", "com.sec.android.app.sbrowser", "com.microsoft.emmx", "com.opera.browser",
        "com.opera.mini.native", "com.brave.browser", "com.duckduckgo.mobile.android", "com.vivaldi.browser",
        "com.kiwibrowser.browser", "com.UCMobile.intl", "com.mi.globalbrowser", "com.huawei.browser",
        "com.android.browser", "org.chromium.webview_shell"
    };

    private static volatile boolean running;
    private static volatile String status = "Filtro detenido.";
    private static final AtomicLong queries = new AtomicLong();
    private static final AtomicLong blockedQueries = new AtomicLong();

    private ParcelFileDescriptor tun;
    private Thread loop;
    private ExecutorService pool;
    private DnsFilter filter;

    static boolean isRunning() { return running; }
    static String getStatus() { return status; }
    static long getQueries() { return queries.get(); }
    static long getBlocked() { return blockedQueries.get(); }

    static SharedPreferences prefs(Context context) { return context.getSharedPreferences(PREFS, MODE_PRIVATE); }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            prefs(this).edit().putBoolean(PREF_ENABLED, false).apply();
            shutdown("Filtro detenido.");
            stopSelf();
            return START_NOT_STICKY;
        }
        // Started by the app, or by the system for "Always-on VPN" (no extras): use the saved scope.
        String scope = intent != null && intent.hasExtra(PREF_SCOPE)
            ? intent.getStringExtra(PREF_SCOPE)
            : prefs(this).getString(PREF_SCOPE, SCOPE_PHONE);
        prefs(this).edit().putString(PREF_SCOPE, scope).putBoolean(PREF_ENABLED, true).apply();
        shutdown(null);
        start(scope);
        return START_STICKY;
    }

    private synchronized void start(String scope) {
        try {
            if (filter == null) filter = new DnsFilter(loadBlocklist());
            Builder builder = new Builder()
                .setSession("Shomer")
                .addAddress(TUN_ADDRESS, 32)
                .addDnsServer(DNS_ADDRESS)
                .addRoute(DNS_ADDRESS, 32)
                .setBlocking(true);
            if (Build.VERSION.SDK_INT >= 29) builder.setMetered(false);
            int browsers = 0;
            if (SCOPE_BROWSERS.equals(scope)) {
                for (String pkg : browserPackages(this)) {
                    try {
                        builder.addAllowedApplication(pkg);
                        browsers++;
                    } catch (PackageManager.NameNotFoundException ignored) {
                        // Not installed.
                    }
                }
                if (browsers == 0) {
                    status = "No se encontró ningún navegador instalado.";
                    stopSelf();
                    return;
                }
            } else {
                builder.addDisallowedApplication(getPackageName());
            }
            tun = builder.establish();
            if (tun == null) {
                status = "Android no concedió la VPN. Vuelve a autorizar el filtro.";
                stopSelf();
                return;
            }
            pool = Executors.newFixedThreadPool(8);
            running = true;
            status = SCOPE_BROWSERS.equals(scope)
                ? "Filtro activo solo en " + browsers + " navegador(es)."
                : "Filtro activo en todas las apps del teléfono.";
            ParcelFileDescriptor descriptor = tun;
            loop = new Thread(() -> readLoop(descriptor), "ShomerDns");
            loop.start();
        } catch (IOException | RuntimeException failure) {
            status = "No se pudo iniciar el filtro (" + failure.getClass().getSimpleName() + ").";
            shutdown(null);
            stopSelf();
        }
    }

    private void readLoop(ParcelFileDescriptor descriptor) {
        FileInputStream in = new FileInputStream(descriptor.getFileDescriptor());
        FileOutputStream out = new FileOutputStream(descriptor.getFileDescriptor());
        byte[] buffer = new byte[32767];
        while (running && !Thread.currentThread().isInterrupted()) {
            int length;
            try {
                length = in.read(buffer);
            } catch (IOException closed) {
                break;
            }
            if (length <= 0) continue;
            DnsFilter.Query query = DnsFilter.parse(buffer, length);
            if (query == null) continue;
            queries.incrementAndGet();
            if (filter.isBlocked(query.name)) {
                byte[] answer = DnsFilter.blockedResponse(query.payload());
                if (answer != null) {
                    blockedQueries.incrementAndGet();
                    write(out, DnsFilter.reply(query, answer));
                }
                continue;
            }
            try {
                pool.execute(() -> forward(query, out));
            } catch (RejectedExecutionException stopping) {
                break;
            }
        }
    }

    private void forward(DnsFilter.Query query, FileOutputStream out) {
        byte[] payload = query.payload();
        try (DatagramSocket socket = new DatagramSocket()) {
            if (!protect(socket)) return;
            socket.setSoTimeout(2500);
            byte[] response = new byte[4096];
            for (String host : UPSTREAM) {
                try {
                    socket.send(new DatagramPacket(payload, payload.length, InetAddress.getByName(host), 53));
                    DatagramPacket packet = new DatagramPacket(response, response.length);
                    socket.receive(packet);
                    if (!DnsFilter.matches(payload, response, packet.getLength())) continue;
                    write(out, DnsFilter.reply(query, Arrays.copyOf(response, packet.getLength())));
                    return;
                } catch (SocketTimeoutException tryNext) {
                    // Try the next resolver.
                }
            }
        } catch (IOException ignored) {
            // The app will retry; nothing is logged.
        }
    }

    private static void write(FileOutputStream out, byte[] packet) {
        synchronized (out) {
            try {
                out.write(packet);
            } catch (IOException ignored) {
                // Interface closed while stopping.
            }
        }
    }

    private List<String> loadBlocklist() throws IOException {
        List<String> lines = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(getAssets().open("blocklist.txt"), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) lines.add(line);
        }
        return lines;
    }

    static Set<String> browserPackages(Context context) {
        Set<String> packages = new LinkedHashSet<>();
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("https://example.com/"));
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        PackageManager manager = context.getPackageManager();
        List<ResolveInfo> handlers = manager.queryIntentActivities(intent, PackageManager.MATCH_ALL);
        for (ResolveInfo info : handlers) {
            if (info.activityInfo != null && !context.getPackageName().equals(info.activityInfo.packageName)) {
                packages.add(info.activityInfo.packageName);
            }
        }
        packages.addAll(Arrays.asList(KNOWN_BROWSERS));
        return packages;
    }

    private synchronized void shutdown(String message) {
        running = false;
        if (loop != null) loop.interrupt();
        if (pool != null) pool.shutdownNow();
        if (tun != null) {
            try {
                tun.close();
            } catch (IOException ignored) {
                // Already closed.
            }
        }
        tun = null;
        loop = null;
        pool = null;
        if (message != null) status = message;
    }

    @Override public void onRevoke() {
        prefs(this).edit().putBoolean(PREF_ENABLED, false).apply();
        shutdown("Otra VPN o el sistema detuvo el filtro. Vuelve a activarlo.");
        stopSelf();
    }

    @Override public void onDestroy() {
        shutdown(running ? "Filtro detenido." : null);
        super.onDestroy();
    }
}
