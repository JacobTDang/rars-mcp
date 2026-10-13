package dev.rarsmcp.protocol;

import java.util.LinkedHashMap;
import java.util.Map;

public final class ProtocolSelfTest {
    public static void main(String[] args) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("token", "secret");
        BridgeRequest request = new BridgeRequest(1, "abc", "hello", payload);
        String encoded = MiniJson.stringify(request.toMap());
        BridgeRequest decoded = BridgeRequest.fromJson(encoded);
        require(decoded.protocolVersion == 1, "protocol version");
        require(decoded.id.equals("abc"), "request id");
        require(decoded.command.equals("hello"), "command");
        require(decoded.payload.get("token").equals("secret"), "payload");

        expectFailure(() -> BridgeRequest.fromJson("{\"protocolVersion\":2,\"id\":\"x\",\"command\":\"hello\",\"payload\":{}}"));
        expectFailure(() -> BridgeRequest.fromJson("{\"protocolVersion\":1,\"command\":\"hello\",\"payload\":{}}"));
        require(Long.valueOf(4).equals(MiniJson.parse("4")), "an integer is a Long");
        require(Long.valueOf(Long.MAX_VALUE).equals(MiniJson.parse("9223372036854775807")), "a 64-bit integer is exact");
        require(Double.valueOf(1.5).equals(MiniJson.parse("1.5")), "a fraction is a Double");
        words();
        System.out.println("ProtocolSelfTest PASS");
    }

    private static void words() {
        require(Words.parseValue("0x7fffffffffffffff", 8, "x") == Long.MAX_VALUE, "8-byte hex");
        require(Words.parseValue("0x8000000000000000", 8, "x") == Long.MIN_VALUE, "8-byte hex above the signed range");
        require(Words.parseValue("18446744073709551615", 8, "x") == -1L, "8-byte unsigned decimal");
        require(Words.parseValue("-9223372036854775808", 8, "x") == Long.MIN_VALUE, "8-byte signed decimal");
        require(Words.parseValue("-2", 8, "x") == -2L, "small negative 8-byte value");
        require(Words.parseValue(41L, 4, "a0") == 41L, "a JSON number");
        require(Words.parseValue("0xffffffff", 4, "t0") == 0xffffffffL && Words.parseValue("-2147483648", 4, "t0") == Integer.MIN_VALUE, "4-byte range");
        require(Words.parseValue("255", 1, "x") == 255L && Words.parseValue("-128", 1, "x") == -128L, "1-byte range");
        requireFailure(() -> Words.parseValue("0x10000000000000000", 8, "0x10010000"), "Value for 0x10010000 does not fit in 8 bytes: 0x10000000000000000");
        requireFailure(() -> Words.parseValue("-9223372036854775809", 8, "0x10010000"), "Value for 0x10010000 does not fit in 8 bytes: -9223372036854775809");
        requireFailure(() -> Words.parseValue("0x100000000", 4, "t0"), "Value for t0 does not fit in 4 bytes: 0x100000000");
        requireFailure(() -> Words.parseValue("0x1ff", 1, "0x10010000"), "Value for 0x10010000 does not fit in 1 byte: 0x1ff");
        requireFailure(() -> Words.parseValue("-129", 1, "0x10010000"), "Value for 0x10010000 does not fit in 1 byte: -129");
        for (String invalid : new String[] { "abc", "0x", "-", "--1", "0x-1", "1.5", "" }) {
            requireFailure(() -> Words.parseValue(invalid, 4, "t0"), "Invalid value for t0: " + invalid);
        }
        requireFailure(() -> Words.parseValue(null, 4, "t0"), "Invalid value for t0: null");

        require(Words.parseAddress("0x10010000") == 0x10010000 && Words.parseAddress("0xffffffff") == -1 && Words.parseAddress(4194304L) == 0x00400000, "addresses");
        requireFailure(() -> Words.parseAddress("0x100000000"), "Address out of range: 0x100000000");
        requireFailure(() -> Words.parseAddress("-4"), "Address out of range: -4");
        requireFailure(() -> Words.parseAddress("nope"), "Invalid address: nope");
    }

    private static void requireFailure(Runnable action, String message) {
        try {
            action.run();
        } catch (IllegalArgumentException error) {
            if (message.equals(error.getMessage())) return;
            throw new AssertionError("expected \"" + message + "\", got \"" + error.getMessage() + "\"");
        }
        throw new AssertionError("expected failure: " + message);
    }

    private static void require(boolean value, String name) {
        if (!value) throw new AssertionError(name);
    }

    private static void expectFailure(Runnable action) {
        try { action.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("expected protocol validation failure");
    }
}
