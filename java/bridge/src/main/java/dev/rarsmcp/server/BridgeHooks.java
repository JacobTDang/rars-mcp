package dev.rarsmcp.server;

import java.util.List;
import java.util.Map;

public interface BridgeHooks {
    void beforeLoad(List<String> files, Map<String, Object> payload) throws Exception;
    void afterMutation() throws Exception;

    BridgeHooks NONE = new BridgeHooks() {
        public void beforeLoad(List<String> files, Map<String, Object> payload) {}
        public void afterMutation() {}
    };
}
