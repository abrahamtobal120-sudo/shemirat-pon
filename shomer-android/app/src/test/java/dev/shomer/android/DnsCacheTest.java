package dev.shomer.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import java.io.ByteArrayOutputStream;
import org.junit.Test;

public class DnsCacheTest {
    private long now = 1_000_000;
    private final DnsCache cache = new DnsCache(2, () -> now);

    @Test public void answersRepeatedQueryWithItsOwnIdAndCase() {
        byte[] first = DnsFilterTest.query(0x1111, "example.com");
        cache.put(first, answer(first, 300));

        byte[] again = DnsFilterTest.query(0x2222, "ExAmple.COM");
        byte[] hit = cache.get(again);
        assertNotNull(hit);
        assertEquals(0x22, hit[0] & 0xFF);
        assertEquals(0x22, hit[1] & 0xFF);
        assertEquals('E', hit[13]); // question echoed exactly as asked
        assertEquals(1, DnsFilter.u16(hit, 6)); // still one answer
    }

    @Test public void expiresAfterTtl() {
        byte[] q = DnsFilterTest.query(1, "example.com");
        cache.put(q, answer(q, 30));
        now += 29_000;
        assertNotNull(cache.get(q));
        now += 2_000;
        assertNull(cache.get(q));
    }

    @Test public void clampsTinyTtlAndSkipsFailures() {
        byte[] q = DnsFilterTest.query(1, "example.com");
        cache.put(q, answer(q, 0));
        now += (DnsCache.MIN_TTL_SECONDS - 1) * 1000L;
        assertNotNull(cache.get(q));

        byte[] other = DnsFilterTest.query(2, "fail.example");
        byte[] servfail = answer(other, 300);
        servfail[3] = (byte) 0x82;
        cache.put(other, servfail);
        assertNull(cache.get(other));
    }

    @Test public void evictsLeastRecentlyUsed() {
        byte[] a = DnsFilterTest.query(1, "a.example");
        byte[] b = DnsFilterTest.query(2, "b.example");
        byte[] c = DnsFilterTest.query(3, "c.example");
        cache.put(a, answer(a, 300));
        cache.put(b, answer(b, 300));
        cache.get(a);
        cache.put(c, answer(c, 300));
        assertNotNull(cache.get(a));
        assertNull(cache.get(b));
        assertEquals(2, cache.size());
    }

    @Test public void readsMinimumTtlAndRejectsGarbage() {
        byte[] q = DnsFilterTest.query(1, "example.com");
        assertEquals(120, DnsCache.minTtl(answer(q, 120)));
        assertEquals(DnsCache.DEFAULT_TTL_SECONDS, DnsCache.minTtl(DnsFilter.blockedResponse(q)));
        byte[] broken = answer(q, 120);
        DnsFilter.put16(broken, 6, 5); // claims more records than it has
        assertEquals(-1, DnsCache.minTtl(broken));
    }

    /** NOERROR response with one A record (compressed name pointer) and the given TTL. */
    static byte[] answer(byte[] query, int ttl) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(query, 0, query.length);
        out.write(0xC0); out.write(12);              // name: pointer to the question
        out.write(0); out.write(1); out.write(0); out.write(1); // A, IN
        out.write(ttl >>> 24); out.write(ttl >>> 16); out.write(ttl >>> 8); out.write(ttl);
        out.write(0); out.write(4); out.write(93); out.write(184); out.write(216); out.write(34);
        byte[] response = out.toByteArray();
        response[2] = (byte) 0x81;
        response[3] = (byte) 0x80;
        DnsFilter.put16(response, 6, 1);
        return response;
    }
}
