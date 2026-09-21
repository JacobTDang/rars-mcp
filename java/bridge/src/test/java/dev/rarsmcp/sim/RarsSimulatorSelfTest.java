package dev.rarsmcp.sim;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

public final class RarsSimulatorSelfTest {
    public static void main(String[] args) throws Exception {
        RarsSimulator simulator = new RarsSimulator();
        simulator.load(Arrays.asList("tests/fixtures/debug.asm"), Collections.emptyList(), "");
        Map<String, Object> initial = simulator.snapshot();
        long initialPc = pc(initial);
        require(((Number) simulator.readRegister("pc")).longValue() == initialPc, "pc read");
        requireThrows(() -> simulator.readRegister("nope"), "Unknown register: nope", "unknown register read");
        requireThrows(() -> simulator.setRegister("nope", 1), "Unknown register: nope", "unknown register write");
        simulator.step();
        require(pc(simulator.snapshot()) == initialPc + 4, "step");
        simulator.setRegister("a0", 41);
        require(((Number) simulator.readRegister("a0")).intValue() == 41, "register write");
        simulator.writeMemory(0x10010000, 4, 1234);
        require(((Number) simulator.readMemory(0x10010000, 4)).intValue() == 1234, "memory write");
        simulator.backstep();
        require(pc(simulator.snapshot()) == initialPc, "backstep");
        simulator.setRegister("pc", (int) initialPc + 8);
        require(pc(simulator.snapshot()) == initialPc + 8, "pc write");
        simulator.reset();
        require(pc(simulator.snapshot()) == initialPc, "reset");

        simulator.load(Arrays.asList("tests/fixtures/debug.asm", "tests/fixtures/debug-helper.asm"), Collections.emptyList(), "");
        List<Map<String, Object>> symbols = simulator.symbols();
        requireSymbol(symbols, "main", "text", false, initialPc);
        requireSymbol(symbols, "value", "data", false, 0x10010000L);
        requireSymbol(symbols, "helper_value", "data", false, null);
        requireSymbol(symbols, "helper", "text", true, null);
        require(symbols.size() == 4, "symbol count " + symbols.size());
        System.out.println("RarsSimulatorSelfTest PASS");
    }

    private static void requireSymbol(List<Map<String, Object>> symbols, String name, String type, boolean global, Long address) {
        for (Map<String, Object> symbol : symbols) {
            if (!name.equals(symbol.get("name"))) continue;
            require(type.equals(symbol.get("type")), name + " type");
            require(Boolean.valueOf(global).equals(symbol.get("global")), name + " global");
            if (address != null) require(String.format("0x%08x", address).equals(symbol.get("address")), name + " address");
            return;
        }
        throw new AssertionError("missing symbol " + name);
    }

    private interface Action { void run() throws Exception; }

    private static long pc(Map<String, Object> snapshot) {
        return Long.decode((String) snapshot.get("programCounter"));
    }

    private static void require(boolean value, String name) {
        if (!value) throw new AssertionError(name);
    }

    private static void requireThrows(Action action, String message, String name) {
        try {
            action.run();
        } catch (IllegalArgumentException error) {
            if (message.equals(error.getMessage())) return;
            throw new AssertionError(name + ": unexpected message " + error.getMessage());
        } catch (Exception error) {
            throw new AssertionError(name + ": unexpected " + error);
        }
        throw new AssertionError(name + ": nothing was thrown");
    }
}
