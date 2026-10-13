package dev.rarsmcp.server;

import dev.rarsmcp.protocol.BridgeRequest;
import dev.rarsmcp.protocol.MiniJson;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class BridgeServerSelfTest {
    private static final String TOKEN = "self-test";
    private static final int RUN_FOREVER = Integer.MAX_VALUE;

    public static void main(String[] args) throws Exception {
        ServerSocket server = new ServerSocket(0, 16, InetAddress.getLoopbackAddress());
        Thread serving = new Thread(() -> {
            try {
                BridgeServer.serveClients(server, TOKEN, "headless", BridgeHooks.NONE, 1 << 20);
            } catch (Exception closed) {
                // The test closes the server socket when it is done.
            }
        }, "bridge-under-test");
        serving.setDaemon(true);
        serving.start();

        try (Client client = new Client(server.getLocalPort())) {
            client.send("hello", "hello", map("token", TOKEN));
            client.send("load", "load", map("files", Arrays.asList("tests/fixtures/infinite.asm")));
            require(client.next().get("id").equals("hello") && client.next().get("id").equals("load"), "hello and load");

            // A pause read while a continue runs stops it; the continue is answered first.
            client.send("run", "command", map("action", "continue", "maxSteps", RUN_FOREVER));
            Thread.sleep(200);
            client.send("pause", "command", map("action", "pause"));
            Map<String, Object> run = client.next();
            Map<String, Object> pause = client.next();
            require(run.get("id").equals("run") && "paused".equals(result(run).get("stopReason")), "paused continue " + run);
            require(pause.get("id").equals("pause") && "paused".equals(result(pause).get("status")), "pause reply " + pause);

            // A pause stops every continue read before it, even one that had not started, and none read after it.
            client.send("first", "command", map("action", "continue", "maxSteps", RUN_FOREVER));
            client.send("second", "command", map("action", "continue", "maxSteps", RUN_FOREVER));
            client.send("pause-both", "command", map("action", "pause"));
            client.send("after", "command", map("action", "continue", "maxSteps", 10));
            List<String> order = new ArrayList<>();
            List<Object> reasons = new ArrayList<>();
            for (int index = 0; index < 4; index++) {
                Map<String, Object> reply = client.next();
                order.add(String.valueOf(reply.get("id")));
                reasons.add(result(reply).get("stopReason"));
            }
            require(order.equals(Arrays.asList("first", "second", "pause-both", "after")), "reply order " + order);
            require(reasons.equals(Arrays.asList("paused", "paused", "paused", "step_limit")), "stop reasons " + reasons);

            // A client that leaves stops what it left running, so the next client is served.
            client.send("abandoned", "command", map("action", "continue", "maxSteps", RUN_FOREVER));
        }
        try (Client next = new Client(server.getLocalPort())) {
            next.send("hello", "hello", map("token", TOKEN));
            next.send("inspect", "inspect", map());
            require(next.next().get("id").equals("hello"), "second client hello");
            Map<String, Object> inspected = next.next();
            require(inspected.get("id").equals("inspect") && "paused".equals(result(inspected).get("stopReason")), "second client inspect " + inspected);
        }
        server.close();
        System.out.println("BridgeServerSelfTest PASS");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> result(Map<String, Object> reply) {
        require(Boolean.TRUE.equals(reply.get("ok")), "request failed: " + reply);
        return (Map<String, Object>) reply.get("result");
    }

    private static Map<String, Object> map(Object... values) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int index = 0; index < values.length; index += 2) result.put(String.valueOf(values[index]), values[index + 1]);
        return result;
    }

    private static void require(boolean value, String name) {
        if (!value) throw new AssertionError(name);
    }

    private static final class Client implements AutoCloseable {
        private final Socket socket;
        private final BufferedReader input;
        private final BufferedWriter output;

        Client(int port) throws Exception {
            socket = new Socket(InetAddress.getLoopbackAddress(), port);
            // A reply that does not come fails the test instead of hanging it.
            socket.setSoTimeout(5_000);
            input = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            output = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
        }

        void send(String id, String command, Map<String, Object> payload) throws Exception {
            output.write(MiniJson.stringify(new BridgeRequest(1, id, command, payload).toMap()));
            output.newLine();
            output.flush();
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> next() throws Exception {
            String line = input.readLine();
            require(line != null, "bridge closed the connection");
            return (Map<String, Object>) MiniJson.parse(line);
        }

        public void close() throws Exception { socket.close(); }
    }
}
