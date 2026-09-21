package dev.rarsmcp.protocol;

import java.util.LinkedHashMap;
import java.util.Map;

public final class Words {
    private Words() {}

    public static String address(int value) {
        return String.format("0x%08x", value);
    }

    // A value `width` bytes wide as { hex, signed }, with the hex zero-padded to that width.
    public static Map<String, Object> word(long value, int width) {
        int bits = width * 8;
        long raw = bits == 64 ? value : value & ((1L << bits) - 1);
        long signed = bits == 64 ? raw : (raw << (64 - bits)) >> (64 - bits);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("hex", String.format("0x%0" + (width * 2) + "x", raw));
        result.put("signed", signed);
        return result;
    }
}
