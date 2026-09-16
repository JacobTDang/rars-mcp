package dev.rarsmcp.server;

import dev.rarsmcp.protocol.BridgeRequest;
import dev.rarsmcp.protocol.BridgeResponse;
import dev.rarsmcp.sim.RarsSimulator;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class BridgeServer {
    private final String token;
    private final RarsSimulator simulator = new RarsSimulator();

    private BridgeServer(String token) { this.token = token; }

    public static void main(String[] args) throws Exception {
        String token = argument(args, "--token");
        int port = Integer.parseInt(argument(args, "--port"));
        BridgeServer bridge = new BridgeServer(token);
        try (ServerSocket server = new ServerSocket(port, 16, InetAddress.getLoopbackAddress())) {
            System.err.println("RARS_MCP_PORT=" + server.getLocalPort());
            System.err.flush();
            while (true) bridge.serve(server.accept());
        }
    }

    private void serve(Socket socket) {
        try (Socket connection = socket;
             BufferedReader input = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8));
             BufferedWriter output = new BufferedWriter(new OutputStreamWriter(connection.getOutputStream(), StandardCharsets.UTF_8))) {
            boolean authenticated = false;
            String line;
            while ((line = input.readLine()) != null) {
                String id = "unknown";
                String response;
                try {
                    BridgeRequest request = BridgeRequest.fromJson(line);
                    id = request.id;
                    if (!authenticated) {
                        if (!request.command.equals("hello") || !token.equals(string(request.payload.get("token")))) {
                            response = BridgeResponse.error(id, "AUTHENTICATION_FAILED", "Invalid bridge token");
                        } else {
                            authenticated = true;
                            response = BridgeResponse.success(id, mapOf("protocolVersion", 1, "mode", "headless"));
                        }
                    } else {
                        response = dispatch(request);
                    }
                } catch (Exception error) {
                    response = BridgeResponse.error(id, "BRIDGE_ERROR", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
                }
                output.write(response);
                output.newLine();
                output.flush();
            }
        } catch (Exception ignored) {
            // A disconnected client ends only its connection; the bridge remains available.
        }
    }

    @SuppressWarnings("unchecked")
    private String dispatch(BridgeRequest request) throws Exception {
        Map<String, Object> payload = request.payload;
        switch (request.command) {
            case "load":
                simulator.load(strings(payload.get("files")), strings(payload.get("programArgs")), string(payload.get("stdin")));
                return BridgeResponse.success(request.id, simulator.snapshot());
            case "assemble":
                return BridgeResponse.success(request.id, simulator.snapshot());
            case "command":
                return BridgeResponse.success(request.id, command(payload));
            case "inspect": {
                Map<String, Object> result = new LinkedHashMap<>(simulator.snapshot());
                Map<String, Object> registers = new LinkedHashMap<>();
                for (String name : strings(payload.get("registers"))) registers.put(name, simulator.readRegister(name));
                result.put("registers", registers);
                List<Object> memory = new ArrayList<>();
                Object ranges = payload.get("memory");
                if (ranges instanceof List) for (Object item : (List<?>) ranges) {
                    Map<String, Object> range = (Map<String, Object>) item;
                    int address = integer(range.get("address"));
                    int width = integer(range.get("width"));
                    memory.add(mapOf("address", address, "width", width, "value", simulator.readMemory(address, width)));
                }
                result.put("memory", memory);
                return BridgeResponse.success(request.id, result);
            }
            case "modify":
                Object registerObject = payload.get("registers");
                if (registerObject instanceof Map) for (Map.Entry<?, ?> entry : ((Map<?, ?>) registerObject).entrySet()) {
                    simulator.setRegister(String.valueOf(entry.getKey()), integer(entry.getValue()));
                }
                Object writes = payload.get("memory");
                if (writes instanceof List) for (Object item : (List<?>) writes) {
                    Map<String, Object> write = (Map<String, Object>) item;
                    simulator.writeMemory(integer(write.get("address")), integer(write.get("width")), number(write.get("value")));
                }
                return BridgeResponse.success(request.id, simulator.snapshot());
            case "close":
                return BridgeResponse.success(request.id, mapOf("closed", true));
            default:
                return BridgeResponse.error(request.id, "UNKNOWN_COMMAND", request.command);
        }
    }

    private Map<String, Object> command(Map<String, Object> payload) throws Exception {
        String action = string(payload.get("action"));
        switch (action) {
            case "step": return simulator.step();
            case "backstep": return simulator.backstep();
            case "continue": return simulator.runUntilStop(payload.containsKey("maxSteps") ? integer(payload.get("maxSteps")) : 1_000_000);
            case "reset": return simulator.reset();
            case "pause": return simulator.snapshot();
            case "breakpoint_add": simulator.addBreakpoint(integer(payload.get("address"))); return simulator.snapshot();
            case "breakpoint_remove": simulator.removeBreakpoint(integer(payload.get("address"))); return simulator.snapshot();
            case "terminate": return simulator.snapshot();
            default: throw new IllegalArgumentException("Unknown debug action: " + action);
        }
    }

    private static String argument(String[] args, String name) {
        for (int i = 0; i + 1 < args.length; i++) if (args[i].equals(name)) return args[i + 1];
        throw new IllegalArgumentException("Missing argument " + name);
    }
    private static String string(Object value) { return value == null ? "" : String.valueOf(value); }
    private static int integer(Object value) { return (int) number(value); }
    private static long number(Object value) { return value instanceof Number ? ((Number) value).longValue() : Long.decode(String.valueOf(value)); }
    private static List<String> strings(Object value) {
        List<String> result = new ArrayList<>();
        if (value instanceof List) for (Object item : (List<?>) value) result.add(String.valueOf(item));
        return result;
    }
    private static Map<String, Object> mapOf(Object... values) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int index = 0; index < values.length; index += 2) result.put(String.valueOf(values[index]), values[index + 1]);
        return result;
    }
}
