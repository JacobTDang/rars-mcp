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
        System.out.println("ProtocolSelfTest PASS");
    }

    private static void require(boolean value, String name) {
        if (!value) throw new AssertionError(name);
    }

    private static void expectFailure(Runnable action) {
        try { action.run(); } catch (IllegalArgumentException expected) { return; }
        throw new AssertionError("expected protocol validation failure");
    }
}
