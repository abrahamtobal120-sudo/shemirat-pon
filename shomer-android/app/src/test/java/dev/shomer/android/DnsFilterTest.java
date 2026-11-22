package dev.shomer.android;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import org.junit.Test;

public class DnsFilterTest {
    private final DnsFilter filter = new DnsFilter(Arrays.asList(
        "# comment", "doubleclick.net", "0.0.0.0 tracker.example", "*.Adult.Example.", "||ads.test^"));

    @Test public void blocksListedDomainsAndSubdomains() {
        assertTrue(filter.isBlocked("doubleclick.net"));
        assertTrue(filter.isBlocked("pubads.g.doubleclick.net."));
        assertTrue(filter.isBlocked("tracker.example"));
        assertTrue(filter.isBlocked("www.adult.example"));
        assertTrue(filter.isBlocked("cdn.ads.test"));
        assertEquals(4, filter.size());
    }

    @Test public void blocksKeywordsAndAllowsOthers() {
        assertTrue(filter.isBlocked("free-porn-site.example"));
        assertFalse(filter.isBlocked("wikipedia.org"));
        assertFalse(filter.isBlocked("notdoubleclick.net"));
        assertFalse(filter.isBlocked(""));
    }

    @Test public void parsesQueryAndBuildsBlockedReply() {
        byte[] dns = query(0x1234, "www.adult.example");
        byte[] packet = ipv4Udp(new byte[]{10, 111, (byte) 222, 1}, new byte[]{10, 111, (byte) 222, 2}, 40000, 53, dns);
        DnsFilter.Query parsed = DnsFilter.parse(packet, packet.length);
        assertNotNull(parsed);
        assertEquals("www.adult.example", parsed.name);
        assertArrayEquals(dns, parsed.payload());

        byte[] answer = DnsFilter.blockedResponse(parsed.payload());
        assertNotNull(answer);
        assertEquals(0x12, answer[0] & 0xFF);
        assertEquals(0x34, answer[1] & 0xFF);
        assertEquals(0x81, answer[2] & 0xFF); // response, recursion desired
        assertEquals(0x83, answer[3] & 0xFF); // NXDOMAIN
        assertTrue(DnsFilter.matches(dns, answer, answer.length));

        byte[] reply = DnsFilter.reply(parsed, answer);
        assertEquals(0x45, reply[0]);
        assertEquals(reply.length, DnsFilter.u16(reply, 2));
        assertEquals(53, DnsFilter.u16(reply, 20));
        assertEquals(40000, DnsFilter.u16(reply, 22));
        assertArrayEquals(new byte[]{10, 111, (byte) 222, 2}, Arrays.copyOfRange(reply, 12, 16));
        assertArrayEquals(new byte[]{10, 111, (byte) 222, 1}, Arrays.copyOfRange(reply, 16, 20));
        assertEquals(DnsFilter.u16(reply, 10), DnsFilter.checksum(reply, 0, 20));
        assertEquals(0, ones(reply, 0, 20));
        assertEquals(0, udpOnes(reply));
    }

    @Test public void ignoresNonDnsPackets() {
        byte[] dns = query(1, "example.com");
        byte[] other = ipv4Udp(new byte[]{1, 2, 3, 4}, new byte[]{5, 6, 7, 8}, 1000, 443, dns);
        assertNull(DnsFilter.parse(other, other.length));
        assertNull(DnsFilter.parse(new byte[10], 10));
        byte[] tcp = ipv4Udp(new byte[]{1, 2, 3, 4}, new byte[]{5, 6, 7, 8}, 1000, 53, dns);
        tcp[9] = 6;
        assertNull(DnsFilter.parse(tcp, tcp.length));
        byte[] truncated = Arrays.copyOf(dns, 15);
        assertNull(DnsFilter.blockedResponse(truncated));
    }

    private static int ones(byte[] data, int offset, int length) {
        long sum = 0;
        for (int i = offset; i < offset + length; i += 2) sum += DnsFilter.u16(data, i);
        while ((sum >> 16) != 0) sum = (sum & 0xFFFF) + (sum >> 16);
        return (int) (~sum & 0xFFFF);
    }

    private static int udpOnes(byte[] p) {
        long sum = 0;
        for (int i = 12; i < 20; i += 2) sum += DnsFilter.u16(p, i);
        sum += 17 + (p.length - 20);
        for (int i = 20; i < p.length; i += 2) sum += ((p[i] & 0xFF) << 8) | (i + 1 < p.length ? p[i + 1] & 0xFF : 0);
        while ((sum >> 16) != 0) sum = (sum & 0xFFFF) + (sum >> 16);
        return (int) (~sum & 0xFFFF);
    }

    static byte[] query(int id, String name) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(id >> 8); out.write(id); out.write(0x01); out.write(0x00);
        out.write(0); out.write(1); for (int i = 0; i < 6; i++) out.write(0);
        for (String label : name.split("\\.")) { out.write(label.length()); for (char c : label.toCharArray()) out.write(c); }
        out.write(0); out.write(0); out.write(1); out.write(0); out.write(1);
        return out.toByteArray();
    }

    static byte[] ipv4Udp(byte[] src, byte[] dst, int srcPort, int dstPort, byte[] payload) {
        int total = 28 + payload.length;
        byte[] p = new byte[total];
        p[0] = 0x45; DnsFilter.put16(p, 2, total); p[8] = 64; p[9] = 17;
        System.arraycopy(src, 0, p, 12, 4); System.arraycopy(dst, 0, p, 16, 4);
        DnsFilter.put16(p, 20, srcPort); DnsFilter.put16(p, 22, dstPort); DnsFilter.put16(p, 24, 8 + payload.length);
        System.arraycopy(payload, 0, p, 28, payload.length);
        return p;
    }
}
