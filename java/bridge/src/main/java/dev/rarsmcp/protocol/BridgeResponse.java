package dev.rarsmcp.protocol;

import java.util.LinkedHashMap;
import java.util.Map;

public final class BridgeResponse {
    private BridgeResponse() {}
    public static String success(String id, Object result) {
        Map<String, Object> map = base(id);
        map.put("ok", true);
        map.put("result", result);
        return MiniJson.stringify(map);
    }
    public static String error(String id, String code, String message) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("code", code);
        detail.put("message", message);
        Map<String, Object> map = base(id);
        map.put("ok", false);
        map.put("error", detail);
        return MiniJson.stringify(map);
    }
    private static Map<String, Object> base(String id) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("protocolVersion", 1);
        map.put("id", id);
        return map;
    }
}
