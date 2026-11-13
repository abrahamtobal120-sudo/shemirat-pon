package dev.shomer.android;

import java.util.Arrays;
import java.util.Collection;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * DNS filtering logic used by {@link FilterVpnService}. Pure Java (no Android APIs) so it can be
 * unit-tested on the JVM. Only IPv4/UDP DNS queries are handled; everything else is ignored.
 */
final class DnsFilter {
    /** Substrings that block a host name even when it is not in the bundled list. */
    private static final String[] KEYWORDS = {
        "porn", "xxx", "hentai", "xvideos", "xnxx", "redtube", "youporn", "onlyfans", "nsfw", "camgirl", "sexcam"
    };

    private final Set<String> blocked = new HashSet<>();

    DnsFilter(Collection<String> lines) {
        for (String line : lines) {
            String host = normalize(line);
            if (!host.isEmpty() && host.indexOf(' ') < 0) blocked.add(host);
        }
    }

    int size() { return blocked.size(); }

    /** Accepts plain domains, hosts-file lines ("0.0.0.0 host"), "*.host" and comments. */
    static String normalize(String line) {
        if (line == null) return "";
        String host = line.trim().toLowerCase(Locale.ROOT);
        int hash = host.indexOf('#');
        if (hash >= 0) host = host.substring(0, hash).trim();
        if (host.startsWith("0.0.0.0 ") || host.startsWith("127.0.0.1 ")) host = host.substring(host.indexOf(' ') + 1).trim();
        if (host.startsWith("||")) host = host.substring(2);
        if (host.endsWith("^")) host = host.substring(0, host.length() - 1);
        if (host.startsWith("*.")) host = host.substring(2);
        while (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        return host;
    }

    /** True if the host, or any parent domain, is blocked. */
    boolean isBlocked(String name) {
        String host = normalize(name);
        if (host.isEmpty()) return false;
        for (String keyword : KEYWORDS) if (host.contains(keyword)) return true;
        String current = host;
        while (true) {
            if (blocked.contains(current)) return true;
            int dot = current.indexOf('.');
            if (dot < 0) return false;
            current = current.substring(dot + 1);
        }
    }

    /** A DNS query read from the tun interface. */
    static final class Query {
        final byte[] packet;
        final int ipHeaderLength;
        final int payloadOffset;
        final int payloadLength;
        final String name;

        Query(byte[] packet, int ipHeaderLength, int payloadOffset, int payloadLength, String name) {
            this.packet = packet;
            this.ipHeaderLength = ipHeaderLength;
            this.payloadOffset = payloadOffset;
            this.payloadLength = payloadLength;
            this.name = name;
        }

        byte[] payload() { return Arrays.copyOfRange(packet, payloadOffset, payloadOffset + payloadLength); }
    }

    /** Returns the query, or null if the packet is not a well-formed IPv4/UDP DNS query to port 53. */
    static Query parse(byte[] packet, int length) {
        if (packet == null || length < 28 || length > packet.length) return null;
        if (((packet[0] >> 4) & 0xF) != 4) return null;
        int ihl = (packet[0] & 0xF) * 4;
        if (ihl < 20 || length < ihl + 8) return null;
        if ((packet[9] & 0xFF) != 17) return null;
        if ((u16(packet, 6) & 0x3FFF) != 0) return null; // fragmented
        int total = u16(packet, 2);
        if (total > length || total < ihl + 8) return null;
        if (u16(packet, ihl + 2) != 53) return null;
        int udpLength = u16(packet, ihl + 4);
        if (udpLength < 8 + 12 || ihl + udpLength > total) return null;
        int offset = ihl + 8;
        int dnsLength = udpLength - 8;
        if ((packet[offset + 2] & 0x80) != 0) return null; // already a response
        String name = questionName(packet, offset, dnsLength);
        if (name == null) return null;
        return new Query(Arrays.copyOf(packet, total), ihl, offset, dnsLength, name);
    }

    static String questionName(byte[] dns, int offset, int length) {
        int end = questionEnd(dns, offset, length);
        if (end < 0) return null;
        StringBuilder name = new StringBuilder();
        int p = offset + 12;
        while (true) {
            int label = dns[p] & 0xFF;
            p++;
            if (label == 0) return name.toString();
            if (name.length() > 0) name.append('.');
            for (int i = 0; i < label; i++) name.append((char) (dns[p + i] & 0xFF));
            p += label;
        }
    }

    /** Offset just after the first question (name + type + class), or -1 if malformed. */
    static int questionEnd(byte[] dns, int offset, int length) {
        if (length < 12 || u16(dns, offset + 4) < 1) return -1;
        int p = offset + 12;
        int end = offset + length;
        int nameLength = 0;
        while (p < end) {
            int label = dns[p] & 0xFF;
            p++;
            if (label == 0) return p + 4 <= end ? p + 4 : -1;
            if ((label & 0xC0) != 0 || p + label > end) return -1;
            nameLength += label + 1;
            if (nameLength > 255) return -1;
            p += label;
        }
        return -1;
    }

    /** NXDOMAIN answer for a DNS query payload. */
    static byte[] blockedResponse(byte[] query) {
        int end = questionEnd(query, 0, query.length);
        if (end < 0) return null;
        byte[] response = Arrays.copyOf(query, end);
        response[2] = (byte) (0x80 | (query[2] & 0x79)); // QR=1, keep opcode and RD
        response[3] = (byte) 0x83;                       // RA=1, RCODE=3 (NXDOMAIN)
        response[4] = 0; response[5] = 1;                // one question
        for (int i = 6; i < 12; i++) response[i] = 0;    // no answers/authority/additional
        return response;
    }

    /** True if the response belongs to the query (same transaction id). */
    static boolean matches(byte[] query, byte[] response, int responseLength) {
        return responseLength >= 12 && query.length >= 2 && query[0] == response[0] && query[1] == response[1];
    }

    /** Wraps a DNS payload in an IPv4/UDP packet addressed back to the app that asked. */
    static byte[] reply(Query query, byte[] dns) {
        int total = 20 + 8 + dns.length;
        byte[] out = new byte[total];
        out[0] = 0x45;
        put16(out, 2, total);
        out[6] = 0x40; // don't fragment
        out[8] = 64;
        out[9] = 17;
        System.arraycopy(query.packet, 16, out, 12, 4);
        System.arraycopy(query.packet, 12, out, 16, 4);
        put16(out, 10, checksum(out, 0, 20));
        put16(out, 20, u16(query.packet, query.ipHeaderLength + 2));
        put16(out, 22, u16(query.packet, query.ipHeaderLength));
        put16(out, 24, 8 + dns.length);
        System.arraycopy(dns, 0, out, 28, dns.length);
        put16(out, 26, udpChecksum(out, total));
        return out;
    }

    private static int udpChecksum(byte[] packet, int total) {
        long sum = 0;
        for (int i = 12; i < 20; i += 2) sum += u16(packet, i);
        sum += 17;
        sum += total - 20;
        for (int i = 20; i < total; i += 2) {
            int high = packet[i] & 0xFF;
            int low = i + 1 < total ? packet[i + 1] & 0xFF : 0;
            if (i != 26) sum += (high << 8) | low;
        }
        while ((sum >> 16) != 0) sum = (sum & 0xFFFF) + (sum >> 16);
        int result = (int) (~sum & 0xFFFF);
        return result == 0 ? 0xFFFF : result;
    }

    static int checksum(byte[] data, int offset, int length) {
        long sum = 0;
        for (int i = offset; i < offset + length; i += 2) {
            if (i == offset + 10) continue;
            sum += u16(data, i);
        }
        while ((sum >> 16) != 0) sum = (sum & 0xFFFF) + (sum >> 16);
        return (int) (~sum & 0xFFFF);
    }

    static int u16(byte[] data, int offset) { return ((data[offset] & 0xFF) << 8) | (data[offset + 1] & 0xFF); }

    static void put16(byte[] data, int offset, int value) {
        data[offset] = (byte) (value >> 8);
        data[offset + 1] = (byte) value;
    }
}
