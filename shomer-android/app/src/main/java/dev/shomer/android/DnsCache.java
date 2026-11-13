package dev.shomer.android;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Small in-memory DNS answer cache (LRU, honours record TTLs) so repeated lookups are answered
 * locally instead of waiting for the upstream resolver. Pure Java so it can be unit-tested.
 * Nothing is written to disk; the cache disappears when the filter stops.
 */
final class DnsCache {
    static final int MIN_TTL_SECONDS = 10;
    static final int MAX_TTL_SECONDS = 3600;
    /** Used for answers without records (e.g. NXDOMAIN with no SOA). */
    static final int DEFAULT_TTL_SECONDS = 60;

    interface Clock { long millis(); }

    private static final class Entry {
        final byte[] response;
        final long expiresAt;
        Entry(byte[] response, long expiresAt) { this.response = response; this.expiresAt = expiresAt; }
    }

    private final Map<String, Entry> entries;
    private final Clock clock;

    DnsCache(int capacity) { this(capacity, System::currentTimeMillis); }

    DnsCache(final int capacity, Clock clock) {
        this.clock = clock;
        this.entries = new LinkedHashMap<String, Entry>(64, 0.75f, true) {
            @Override protected boolean removeEldestEntry(Map.Entry<String, Entry> eldest) { return size() > capacity; }
        };
    }

    synchronized int size() { return entries.size(); }

    synchronized void clear() { entries.clear(); }

    /** Cached response rewritten for this query (its transaction id and question), or null. */
    byte[] get(byte[] query) {
        String key = key(query);
        if (key == null) return null;
        Entry entry;
        synchronized (this) {
            entry = entries.get(key);
            if (entry == null) return null;
            if (clock.millis() >= entry.expiresAt) {
                entries.remove(key);
                return null;
            }
        }
        int questionEnd = DnsFilter.questionEnd(query, 0, query.length);
        byte[] response = entry.response.clone();
        response[0] = query[0];
        response[1] = query[1];
        // Same question, possibly different letter case (DNS 0x20): echo the asker's exact bytes.
        System.arraycopy(query, 12, response, 12, questionEnd - 12);
        return response;
    }

    /** Stores a successful (NOERROR) or NXDOMAIN response to the query. */
    void put(byte[] query, byte[] response) {
        String key = key(query);
        if (key == null || response == null || response.length < 12) return;
        if ((response[2] & 0x02) != 0) return; // truncated: the app will retry over TCP
        int rcode = response[3] & 0x0F;
        if (rcode != 0 && rcode != 3) return;
        int ttl = minTtl(response);
        if (ttl < 0) return; // malformed
        ttl = Math.max(MIN_TTL_SECONDS, Math.min(MAX_TTL_SECONDS, ttl));
        Entry entry = new Entry(response.clone(), clock.millis() + ttl * 1000L);
        synchronized (this) { entries.put(key, entry); }
    }

    /** Lower-cased question (name, type, class), or null if the query is malformed. */
    static String key(byte[] query) {
        if (query == null) return null;
        int end = DnsFilter.questionEnd(query, 0, query.length);
        if (end < 0) return null;
        return new String(query, 12, end - 12, StandardCharsets.ISO_8859_1).toLowerCase(Locale.ROOT);
    }

    /**
     * Smallest TTL among answer and authority records, DEFAULT_TTL_SECONDS if there are none,
     * or -1 if the response cannot be parsed.
     */
    static int minTtl(byte[] dns) {
        int p = DnsFilter.questionEnd(dns, 0, dns.length);
        if (p < 0) return -1;
        int records = DnsFilter.u16(dns, 6) + DnsFilter.u16(dns, 8);
        long min = Long.MAX_VALUE;
        for (int i = 0; i < records; i++) {
            p = skipName(dns, p);
            if (p < 0 || p + 10 > dns.length) return -1;
            long ttl = ((long) (dns[p + 4] & 0xFF) << 24) | ((dns[p + 5] & 0xFF) << 16)
                | ((dns[p + 6] & 0xFF) << 8) | (dns[p + 7] & 0xFF);
            int rdLength = DnsFilter.u16(dns, p + 8);
            p += 10 + rdLength;
            if (p > dns.length) return -1;
            min = Math.min(min, ttl);
        }
        if (min == Long.MAX_VALUE) return DEFAULT_TTL_SECONDS;
        return (int) Math.min(min, Integer.MAX_VALUE);
    }

    private static int skipName(byte[] dns, int p) {
        while (p < dns.length) {
            int label = dns[p] & 0xFF;
            if (label == 0) return p + 1;
            if ((label & 0xC0) == 0xC0) return p + 2 <= dns.length ? p + 2 : -1;
            if ((label & 0xC0) != 0) return -1;
            p += 1 + label;
        }
        return -1;
    }
}
