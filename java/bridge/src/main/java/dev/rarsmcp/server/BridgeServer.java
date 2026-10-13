package dev.rarsmcp.server;

import dev.rarsmcp.protocol.BridgeRequest;
import dev.rarsmcp.protocol.BridgeResponse;
import dev.rarsmcp.protocol.Words;
import dev.rarsmcp.sim.RarsSimulator;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

public final class BridgeServer {
    private final String token;
    private final RarsSimulator simulator;
    private final BridgeHooks hooks;
    private final String mode;

    private BridgeServer(String token, String mode, BridgeHooks hooks, long maxOutputBytes) {
        this.token = token;
        this.mode = mode;
        this.hooks = hooks;
        this.simulator = new RarsSimulator(maxOutputBytes);
    }

    public static void main(String[] args) throws Exception {
        String token = argument(args, "--token");
        int port = Integer.parseInt(argument(args, "--port"));
        run(token, port, "headless", BridgeHooks.NONE, Long.parseLong(argument(args, "--max-output-bytes")));
    }

    // maxOutputBytes: the most program output, stdout and stderr together, kept from one run.
    public static void run(String token, int port, String mode, BridgeHooks hooks, long maxOutputBytes) throws Exception {
        try (ServerSocket server = new ServerSocket(port, 16, InetAddress.getLoopbackAddress())) {
            System.err.println("RARS_MCP_PORT=" + server.getLocalPort());
            System.err.flush();
            serveClients(server, token, mode, hooks, maxOutputBytes);
        }
    }

    // Serves one client at a time until the server socket is closed.
    static void serveClients(ServerSocket server, String token, String mode, BridgeHooks hooks, long maxOutputBytes) throws Exception {
        BridgeServer bridge = new BridgeServer(token, mode, hooks, maxOutputBytes);
        while (true) bridge.serve(server.accept());
    }

    // This thread reads the client's requests and a worker thread answers them, one at a time and
    // in order. Each request is numbered as it is read, and a pause stops every continue read
    // before it, so a pause reaches a continue that is still running.
    private void serve(Socket socket) throws InterruptedException {
        ExecutorService worker = Executors.newSingleThreadExecutor((task) -> new Thread(task, "rars-bridge-worker"));
        try (Socket connection = socket) {
            Client client = new Client(new BufferedWriter(new OutputStreamWriter(connection.getOutputStream(), StandardCharsets.UTF_8)));
            try {
                client.read(new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8)), worker);
            } finally {
                // What the client left running stops and what it left queued is dropped, so the
                // next client finds the simulator free.
                client.leave();
            }
        } catch (IOException ignored) {
            // A disconnected client ends only its connection; the bridge remains available.
        } finally {
            worker.shutdown();
            worker.awaitTermination(Long.MAX_VALUE, TimeUnit.NANOSECONDS);
        }
    }

    // One connection. Only the reader thread writes pausedBefore and gone; only the worker thread
    // authenticates and writes replies.
    private final class Client {
        private final BufferedWriter output;
        // Requests numbered below this are paused.
        private volatile long pausedBefore;
        private volatile boolean gone;
        private boolean authenticated;

        Client(BufferedWriter output) { this.output = output; }

        void read(BufferedReader input, ExecutorService worker) throws IOException {
            long count = 0;
            String line;
            while ((line = input.readLine()) != null) {
                long number = ++count;
                BridgeRequest request;
                try {
                    request = BridgeRequest.fromJson(line);
                } catch (Exception error) {
                    worker.execute(() -> send(failure("unknown", error)));
                    continue;
                }
                if (request.command.equals("command") && "pause".equals(string(request.payload.get("action")))) pausedBefore = number;
                worker.execute(() -> answer(request, number));
            }
        }

        void answer(BridgeRequest request, long number) {
            if (gone) return;
            String response;
            try {
                if (!authenticated) {
                    if (!request.command.equals("hello") || !token.equals(string(request.payload.get("token")))) {
                        response = BridgeResponse.error(request.id, "AUTHENTICATION_FAILED", "Invalid bridge token");
                    } else {
                        authenticated = true;
                        response = BridgeResponse.success(request.id, mapOf("protocolVersion", 1, "mode", mode));
                    }
                } else {
                    response = dispatch(request, () -> number < pausedBefore);
                }
            } catch (Exception error) {
                response = failure(request.id, error);
            }
            send(response);
        }

        void send(String response) {
            if (gone) return;
            try {
                output.write(response);
                output.newLine();
                output.flush();
            } catch (IOException disconnected) {
                // The reader thread sees the same disconnection and ends the connection.
            }
        }

        void leave() {
            gone = true;
            pausedBefore = Long.MAX_VALUE;
        }
    }

    private static String failure(String id, Exception error) {
        return BridgeResponse.error(id, "BRIDGE_ERROR", error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage());
    }

    @SuppressWarnings("unchecked")
    private String dispatch(BridgeRequest request, BooleanSupplier pauseRequested) throws Exception {
        Map<String, Object> payload = request.payload;
        switch (request.command) {
            case "load":
                List<String> files = strings(payload.get("files"));
                hooks.beforeLoad(files, payload);
                simulator.load(files, strings(payload.get("programArgs")), string(payload.get("stdin")));
                hooks.afterMutation();
                return BridgeResponse.success(request.id, simulator.snapshot());
            case "assemble":
                return BridgeResponse.success(request.id, simulator.snapshot());
            case "command":
                Map<String, Object> commandResult = command(payload, pauseRequested);
                hooks.afterMutation();
                return BridgeResponse.success(request.id, commandResult);
            case "inspect": {
                // Everything here that can fail comes before the snapshot, which hands over the new output.
                Map<String, Object> registers = new LinkedHashMap<>();
                for (String name : strings(payload.get("registers"))) {
                    registers.put(name, Words.word(((Number) simulator.readRegister(name)).longValue(), 4));
                }
                List<Object> memory = new ArrayList<>();
                Object ranges = payload.get("memory");
                if (ranges instanceof List) for (Object item : (List<?>) ranges) {
                    Map<String, Object> range = (Map<String, Object>) item;
                    int address = Words.parseAddress(range.get("address"));
                    int width = integer(range.get("width"));
                    Map<String, Object> entry = mapOf("address", Words.address(address), "width", width);
                    entry.putAll(Words.word(((Number) simulator.readMemory(address, width)).longValue(), width));
                    memory.add(entry);
                }
                Object symbols = Boolean.TRUE.equals(payload.get("includeSymbols")) ? simulator.symbols() : null;
                Object window = payload.get("instructions");
                boolean everyInstruction = Boolean.TRUE.equals(payload.get("includeInstructions"));
                if (everyInstruction && window != null) throw new IllegalArgumentException("includeInstructions and instructions cannot be combined");
                Object listed = everyInstruction ? simulator.instructions() : window != null ? instructions(window) : null;
                Map<String, Object> result = new LinkedHashMap<>(simulator.snapshot());
                result.put("registers", registers);
                result.put("memory", memory);
                if (symbols != null) result.put("symbols", symbols);
                if (listed != null) result.put("instructions", listed);
                return BridgeResponse.success(request.id, result);
            }
            case "modify":
                Object registers = payload.getOrDefault("registers", Collections.emptyMap());
                Object writes = payload.getOrDefault("memory", Collections.emptyList());
                if (!(registers instanceof Map)) throw new IllegalArgumentException("registers must be an object");
                if (!(writes instanceof List)) throw new IllegalArgumentException("memory must be an array");
                simulator.modify((Map<?, ?>) registers, (List<?>) writes);
                hooks.afterMutation();
                return BridgeResponse.success(request.id, simulator.snapshot());
            case "encode":
                // Assembling resets RARS's global state, which the visible RARS depends on.
                if (!mode.equals("headless")) throw new IllegalStateException("encode runs only in a headless bridge");
                return BridgeResponse.success(request.id, mapOf("instructions", simulator.encode(strings(payload.get("instructions")))));
            default:
                return BridgeResponse.error(request.id, "UNKNOWN_COMMAND", request.command);
        }
    }

    private Map<String, Object> command(Map<String, Object> payload, BooleanSupplier pauseRequested) throws Exception {
        String action = string(payload.get("action"));
        switch (action) {
            case "step": return simulator.step();
            case "backstep": return simulator.backstep();
            case "continue":
                return simulator.runUntilStop(payload.containsKey("maxSteps") ? integer(payload.get("maxSteps")) : 1_000_000, pauseRequested);
            case "reset": return simulator.reset();
            // The pause itself took effect as the request was read; here it reports where the program stopped.
            case "pause": return simulator.snapshot();
            case "breakpoint_add": return simulator.addBreakpoint(string(payload.get("address")));
            case "breakpoint_remove": return simulator.removeBreakpoint(string(payload.get("address")));
            case "terminate": return simulator.terminate();
            default: throw new IllegalArgumentException("Unknown debug action: " + action);
        }
    }

    // { around, count } or { from, to }; an empty window is the 10 instructions around the program counter.
    private List<Map<String, Object>> instructions(Object value) throws Exception {
        if (!(value instanceof Map)) throw new IllegalArgumentException("instructions must be an object");
        Map<?, ?> window = (Map<?, ?>) value;
        if (!window.containsKey("from") && !window.containsKey("to")) {
            return simulator.instructionsAround(window.containsKey("around") ? string(window.get("around")) : "pc",
                    window.containsKey("count") ? integer(window.get("count")) : 10);
        }
        if (!window.containsKey("from") || !window.containsKey("to") || window.containsKey("around") || window.containsKey("count")) {
            throw new IllegalArgumentException("instructions takes around and count, or both from and to");
        }
        return simulator.instructionsBetween(string(window.get("from")), string(window.get("to")));
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
