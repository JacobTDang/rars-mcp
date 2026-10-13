package dev.rarsmcp.protocol;

import java.math.BigInteger;
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

    // A value for `width` bytes, signed or unsigned, so 8 bytes take -2^63 through 2^64 - 1. Returns
    // its bit pattern; `target` names what the value is for in an error.
    public static long parseValue(Object value, int width, String target) {
        BigInteger number = decode(value);
        if (number == null) throw new IllegalArgumentException("Invalid value for " + target + ": " + value);
        int bits = width * 8;
        BigInteger lowest = BigInteger.ONE.shiftLeft(bits - 1).negate();
        BigInteger highest = BigInteger.ONE.shiftLeft(bits).subtract(BigInteger.ONE);
        if (number.compareTo(lowest) < 0 || number.compareTo(highest) > 0) {
            throw new IllegalArgumentException("Value for " + target + " does not fit in " + width + (width == 1 ? " byte: " : " bytes: ") + value);
        }
        return number.longValue();
    }

    // An address from 0 through 0xffffffff.
    public static int parseAddress(Object value) {
        BigInteger number = decode(value);
        if (number == null) throw new IllegalArgumentException("Invalid address: " + value);
        if (number.signum() < 0 || number.bitLength() > 32) throw new IllegalArgumentException("Address out of range: " + value);
        return number.intValue();
    }

    // The forms Long.decode reads: an optional sign, then 0x, 0X or # for hex, a leading 0 for octal, or
    // decimal; but with no 64-bit limit. A JSON integer is read as it is. Null for anything else.
    private static BigInteger decode(Object value) {
        if (value instanceof Long || value instanceof Integer) return BigInteger.valueOf(((Number) value).longValue());
        if (!(value instanceof String)) return null;
        String text = (String) value;
        boolean negative = text.startsWith("-");
        int at = negative || text.startsWith("+") ? 1 : 0;
        int radix = 10;
        if (text.startsWith("0x", at) || text.startsWith("0X", at)) { radix = 16; at += 2; }
        else if (text.startsWith("#", at)) { radix = 16; at += 1; }
        else if (text.startsWith("0", at) && text.length() > at + 1) { radix = 8; at += 1; }
        String digits = text.substring(at);
        if (digits.isEmpty() || digits.startsWith("-") || digits.startsWith("+")) return null;
        try {
            BigInteger magnitude = new BigInteger(digits, radix);
            return negative ? magnitude.negate() : magnitude;
        } catch (NumberFormatException error) {
            return null;
        }
    }
}
