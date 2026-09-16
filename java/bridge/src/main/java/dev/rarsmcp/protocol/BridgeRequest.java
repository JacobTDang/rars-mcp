package dev.rarsmcp.protocol;

import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

public final class BridgeRequest {
    private static final Set<String> COMMANDS = new HashSet<>(Arrays.asList(
        "hello", "load", "assemble", "command", "inspect", "modify", "close"
    ));
    public final int protocolVersion;
    public final String id;
    public final String command;
    public final Map<String, Object> payload;

    public BridgeRequest(int protocolVersion, String id, String command, Map<String, Object> payload) {
        if (protocolVersion != 1) throw new IllegalArgumentException("Unsupported protocol version");
        if (id == null || id.isEmpty()) throw new IllegalArgumentException("Missing request id");
        if (!COMMANDS.contains(command)) throw new IllegalArgumentException("Unknown command");
        this.protocolVersion = protocolVersion;
        this.id = id;
        this.command = command;
        this.payload = payload;
    }

    @SuppressWarnings("unchecked")
    public static BridgeRequest fromJson(String json) {
        if (json.length() > 1_048_576) throw new IllegalArgumentException("Request exceeds 1 MiB");
        Object parsed = MiniJson.parse(json);
        if (!(parsed instanceof Map)) throw new IllegalArgumentException("Request must be an object");
        Map<String, Object> map = (Map<String, Object>) parsed;
        Object version = map.get("protocolVersion");
        Object id = map.get("id");
        Object command = map.get("command");
        Object payload = map.get("payload");
        if (!(version instanceof Number) || !(id instanceof String) || !(command instanceof String) || !(payload instanceof Map)) {
            throw new IllegalArgumentException("Invalid request envelope");
        }
        return new BridgeRequest(((Number) version).intValue(), (String) id, (String) command, (Map<String, Object>) payload);
    }

    public Map<String, Object> toMap() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("protocolVersion", protocolVersion);
        map.put("id", id);
        map.put("command", command);
        map.put("payload", payload);
        return map;
    }
}
