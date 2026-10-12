package dev.rarsmcp.sim;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
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
        requireThrows(IllegalArgumentException.class, () -> simulator.readRegister("nope"), "Unknown register: nope", "unknown register read");
        requireThrows(IllegalArgumentException.class, () -> simulator.setRegister("nope", 1), "Unknown register: nope", "unknown register write");
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

        simulator.load(Arrays.asList("tests/fixtures/debug.asm"), Collections.emptyList(), "");
        require("step".equals(simulator.step().get("stopReason")), "step reason");
        simulator.addBreakpoint("debug.asm:7");
        Map<String, Object> atBreakpoint = simulator.runUntilStop(1000);
        require("breakpoint".equals(atBreakpoint.get("stopReason")) && pc(atBreakpoint) == initialPc + 8, "breakpoint reason");
        simulator.removeBreakpoint(String.valueOf(initialPc + 8));
        require(((java.util.List<?>) simulator.addBreakpoint("main").get("breakpoints")).contains("0x00400000"), "label breakpoint");
        simulator.removeBreakpoint("0x00400000");
        requireThrows(IllegalArgumentException.class, () -> simulator.addBreakpoint("nope"), "Unknown label: nope", "unknown label");
        requireThrows(IllegalArgumentException.class, () -> simulator.addBreakpoint("value"), "value is a data label, not a code label", "data label");
        requireThrows(IllegalArgumentException.class, () -> simulator.addBreakpoint("debug.asm:2"), "No instruction at debug.asm:2", "line without code");
        Map<String, Object> exited = simulator.runUntilStop(1000);
        require("exited".equals(exited.get("stopReason")) && "terminated".equals(exited.get("status")), "exit reason");

        String terminatedMessage = "The program has terminated; reset the session to run it again";
        requireThrows(IllegalStateException.class, () -> simulator.step(), terminatedMessage, "step after exit");

        simulator.load(Arrays.asList("tests/fixtures/debug.asm"), Collections.emptyList(), "");
        simulator.step();
        Map<String, Object> terminated = simulator.terminate();
        require("terminated".equals(terminated.get("status")) && "terminated".equals(terminated.get("stopReason")), "terminate");
        requireThrows(IllegalStateException.class, () -> simulator.step(), terminatedMessage, "step after terminate");
        requireThrows(IllegalStateException.class, () -> simulator.runUntilStop(10), terminatedMessage, "continue after terminate");
        require("paused".equals(simulator.backstep().get("status")) && pc(simulator.snapshot()) == initialPc, "backstep after terminate");
        simulator.terminate();
        require("paused".equals(simulator.reset().get("status")), "reset after terminate");
        require("step".equals(simulator.step().get("stopReason")), "step after reset");

        simulator.load(Arrays.asList("tests/fixtures/infinite.asm"), Collections.emptyList(), "");
        Map<String, Object> limited = simulator.runUntilStop(100);
        require("step_limit".equals(limited.get("stopReason")) && "paused".equals(limited.get("status")), "step limit reason");

        simulator.load(Arrays.asList("tests/fixtures/dropoff.asm"), Collections.emptyList(), "");
        require("ran_off_end".equals(simulator.runUntilStop(1000).get("stopReason")), "ran off end reason");

        simulator.load(Arrays.asList("tests/fixtures/fault.asm"), Collections.emptyList(), "");
        Map<String, Object> faulted = simulator.runUntilStop(1000);
        require("exception".equals(faulted.get("stopReason")) && "terminated".equals(faulted.get("status")), "exception reason");
        require(String.valueOf(faulted.get("exception")).contains("Load address not aligned"), "exception message");

        simulator.load(Arrays.asList("tests/fixtures/debug.asm", "tests/fixtures/debug-helper.asm"), Collections.emptyList(), "");
        List<Map<String, Object>> symbols = simulator.symbols();
        requireSymbol(symbols, "main", "text", false, initialPc);
        requireSymbol(symbols, "value", "data", false, 0x10010000L);
        requireSymbol(symbols, "helper_value", "data", false, null);
        requireSymbol(symbols, "helper", "text", true, null);
        require(symbols.size() == 4, "symbol count " + symbols.size());
        List<Map<String, Object>> instructions = simulator.instructions();
        Map<String, Object> first = instructions.get(0);
        require("0x00400000".equals(first.get("address")) && "0x00100513".equals(first.get("code")), "first instruction address and code");
        require("li a0, 1".equals(first.get("source")) && Integer.valueOf(5).equals(first.get("line")), "first instruction source");
        require(String.valueOf(first.get("basic")).startsWith("addi"), "first instruction basic " + first.get("basic"));
        require(String.valueOf(first.get("file")).endsWith("debug.asm"), "first instruction file");
        require(String.valueOf(instructions.get(instructions.size() - 1).get("file")).endsWith("debug-helper.asm"), "second file instructions");

        List<String> program = Arrays.asList("0x00400000", "0x00400004", "0x00400008", "0x0040000c", "0x00400010");
        require(addresses(simulator.instructionsAround("pc", 10)).equals(program), "window around pc stops at the program's ends");
        require(addresses(simulator.instructionsAround("0x00400008", 3)).equals(program.subList(1, 4)), "odd window");
        require(addresses(simulator.instructionsAround("0x00400008", 4)).equals(program.subList(1, 5)), "even window puts the extra one after");
        require(addresses(simulator.instructionsAround("helper", 1)).equals(program.subList(4, 5)), "window around a label");
        require(simulator.instructionsAround("main", 1).get(0).equals(first), "window keeps the instruction shape");
        simulator.step();
        require(addresses(simulator.instructionsAround("pc", 1)).equals(program.subList(1, 2)), "window follows pc");
        require(addresses(simulator.instructionsBetween("main", "0x00400008")).equals(program.subList(0, 3)), "inclusive range");
        requireThrows(IllegalArgumentException.class, () -> simulator.instructionsAround("nope", 3), "Unknown label: nope", "window around an unknown label");
        requireThrows(IllegalArgumentException.class, () -> simulator.instructionsBetween("main", "nope"), "Unknown label: nope", "range to an unknown label");
        requireThrows(IllegalArgumentException.class, () -> simulator.instructionsAround("0x10010000", 3), "No instruction at 0x10010000", "window around data");
        String countMessage = "count must be between 1 and 200";
        requireThrows(IllegalArgumentException.class, () -> simulator.instructionsAround("pc", 0), countMessage, "empty window");
        requireThrows(IllegalArgumentException.class, () -> simulator.instructionsAround("pc", 201), countMessage, "window over the limit");
        requireThrows(IllegalArgumentException.class, () -> simulator.instructionsBetween("0x00400008", "main"), "0x00400008 comes after main", "backwards range");

        simulator.load(Arrays.asList("tests/fixtures/debug.asm"), Collections.emptyList(), "");
        simulator.runUntilStop(1000);
        requireThrows(IllegalArgumentException.class, () -> simulator.instructionsAround("pc", 10), "No instruction at pc (0x00400010)", "window after exit");

        // Longer than the window limit, with a label in the middle.
        Path longProgram = Files.createTempFile("rars-window", ".asm");
        longProgram.toFile().deleteOnExit();
        StringBuilder source = new StringBuilder(".text\nmain:\n");
        for (int index = 0; index < 250; index++) source.append(index == 125 ? "middle:\n" : "").append("  addi t0, t0, 1\n");
        Files.write(longProgram, source.toString().getBytes(StandardCharsets.UTF_8));
        simulator.load(Arrays.asList(longProgram.toString()), Collections.emptyList(), "");
        List<String> middle = addresses(simulator.instructionsAround("middle", 200));
        require(middle.size() == 200 && middle.get(0).equals("0x00400068") && middle.get(199).equals("0x00400384"), "full window around a label");
        require(simulator.instructionsBetween("main", "0x0040031c").size() == 200, "range at the limit");
        requireThrows(IllegalArgumentException.class, () -> simulator.instructionsBetween("main", "0x004003e4"),
                "The range main to 0x004003e4 holds 250 instructions; the limit is 200", "range over the limit");
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

    private static List<String> addresses(List<Map<String, Object>> instructions) {
        List<String> result = new ArrayList<>();
        for (Map<String, Object> instruction : instructions) result.add((String) instruction.get("address"));
        return result;
    }

    private interface Action { void run() throws Exception; }

    private static long pc(Map<String, Object> snapshot) {
        return Long.decode((String) snapshot.get("programCounter"));
    }

    private static void require(boolean value, String name) {
        if (!value) throw new AssertionError(name);
    }

    private static void requireThrows(Class<? extends Exception> type, Action action, String message, String name) {
        try {
            action.run();
        } catch (Exception error) {
            if (type.isInstance(error) && message.equals(error.getMessage())) return;
            throw new AssertionError(name + ": unexpected " + error);
        }
        throw new AssertionError(name + ": nothing was thrown");
    }
}
