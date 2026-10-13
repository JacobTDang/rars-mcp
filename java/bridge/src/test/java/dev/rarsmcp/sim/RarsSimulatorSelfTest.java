package dev.rarsmcp.sim;

import rars.Globals;
import rars.riscv.BasicInstruction;
import rars.riscv.Instruction;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
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
        require(addresses(simulator.instructionsAround("pc", 10)).equals(program.subList(0, 4)), "window after exit");
        require(addresses(simulator.instructionsAround("pc", 2)).equals(program.subList(2, 4)), "window after exit ends at the last instruction");
        requireThrows(IllegalArgumentException.class, () -> simulator.instructionsAround("0x00400010", 3), "No instruction at 0x00400010", "address past the end");
        simulator.setRegister("pc", 0x00300000);
        requireThrows(IllegalArgumentException.class, () -> simulator.instructionsAround("pc", 3), "No instruction at pc (0x00300000)", "pc below the program");

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
        simulator.runUntilStop(1000);
        List<String> tail = addresses(simulator.instructionsAround("pc", 10));
        require(tail.size() == 10 && tail.get(0).equals("0x004003c0") && tail.get(9).equals("0x004003e4"), "last 10 instructions after running off the end");
        requireThrows(IllegalStateException.class, () -> simulator.encode(Arrays.asList("nop")),
                "Encoding needs a bridge with no program loaded", "encode with a program loaded");

        encode();
        System.out.println("RarsSimulatorSelfTest PASS");
    }

    private static void encode() throws Exception {
        List<String> sources = Arrays.asList(
                "sub x5, x6, x7", "addi t0, a6, 8", "lw t2, 64(t0)", "sw t2, -4(sp)", "beq x1, x2, 8", "lui t0, 0xfeed2",
                "jal ra, 16", "slli t0, t0, 12", "li t1, 0xFEED2050", "addi t0, t0", "bne t0, t1, -8", "srai t0, t0, 3",
                "fmadd.s f1, f2, f3, f4", "loop: addi t0, t0, 1", "bnez t0, loop", "beq x1, x2, 8192", "beq x1, x2, 3",
                "done:", ".data", "ecall");
        List<Map<String, Object>> encoded = new RarsSimulator().encode(sources);
        require(encoded.size() == sources.size(), "one result per instruction");
        for (int index = 0; index < sources.size(); index++) require(sources.get(index).equals(encoded.get(index).get("source")), "source " + index);

        requireWord(encoded.get(0), 0, "0x407302b3", "R", "opcode", 0x33, "rd", 5, "funct3", 0, "rs1", 6, "rs2", 7, "funct7", 0x20);
        require(Arrays.asList("sub x5,x6,x7").equals(encoded.get(0).get("basic")), "basic form " + encoded.get(0).get("basic"));
        requireWord(encoded.get(1), 0, "0x00880293", "I", "opcode", 0x13, "rd", 5, "funct3", 0, "rs1", 16, "imm", 8);
        requireWord(encoded.get(2), 0, "0x0402a383", "I", "opcode", 0x03, "rd", 7, "funct3", 2, "rs1", 5, "imm", 64);
        requireWord(encoded.get(3), 0, "0xfe712e23", "S", "opcode", 0x23, "funct3", 2, "rs1", 2, "rs2", 7, "imm", -4);
        requireWord(encoded.get(4), 0, "0x00208463", "B", "opcode", 0x63, "funct3", 0, "rs1", 1, "rs2", 2, "imm", 8);
        requireWord(encoded.get(5), 0, "0xfeed22b7", "U", "opcode", 0x37, "rd", 5, "imm", 0xfeed2);
        requireWord(encoded.get(6), 0, "0x010000ef", "J", "opcode", 0x6f, "rd", 1, "imm", 16);
        requireWord(encoded.get(7), 0, "0x00c29293", "I", "opcode", 0x13, "rd", 5, "funct3", 1, "rs1", 5, "shamt", 12, "funct7", 0);
        // A pseudo-instruction: one word per basic instruction it expands to.
        requireWord(encoded.get(8), 0, "0xfeed2337", "U", "opcode", 0x37, "rd", 6, "imm", 0xfeed2);
        requireWord(encoded.get(8), 1, "0x05030313", "I", "opcode", 0x13, "rd", 6, "funct3", 0, "rs1", 6, "imm", 0x50);
        List<?> liBasic = (List<?>) encoded.get(8).get("basic");
        require(liBasic.size() == 2 && String.valueOf(liBasic.get(0)).startsWith("lui") && String.valueOf(liBasic.get(1)).startsWith("addi"), "pseudo basic forms " + liBasic);
        requireError(encoded.get(9), "Too few or incorrectly formatted operands");
        requireWord(encoded.get(10), 0, "0xfe629ce3", "B", "opcode", 0x63, "funct3", 1, "rs1", 5, "rs2", 6, "imm", -8);
        requireWord(encoded.get(11), 0, "0x4032d293", "I", "opcode", 0x13, "rd", 5, "funct3", 5, "rs1", 5, "shamt", 3, "funct7", 0x20);
        requireWord(encoded.get(12), 0, "0x203170c3", "R4", "opcode", 0x43, "rd", 1, "funct3", 7, "rs1", 2, "rs2", 3, "funct2", 0, "rs3", 4);
        requireWord(encoded.get(13), 0, "0x00128293", "I", "opcode", 0x13, "rd", 5, "funct3", 0, "rs1", 5, "imm", 1);
        // Labels work across instructions, laid out one after another as in a program.
        requireWord(encoded.get(14), 0, "0xfe029ee3", "B", "opcode", 0x63, "funct3", 1, "rs1", 5, "rs2", 0, "imm", -4);
        requireError(encoded.get(15), "Branch target word address beyond 12-bit range");
        requireError(encoded.get(16), "Branch and jump offsets must be even, not 3");
        requireError(encoded.get(17), "Not an instruction");
        requireError(encoded.get(18), "Not an instruction");
        requireWord(encoded.get(19), 0, "0x00000073", "I", "opcode", 0x73, "rd", 0, "funct3", 0, "rs1", 0, "imm", 0);

        // A backward jump from the first instruction targets an address below the text segment.
        requireWord(new RarsSimulator().encode(Arrays.asList("jal x0, -2048")).get(0), 0, "0x801ff06f", "J", "opcode", 0x6f, "rd", 0, "imm", -2048);
        requireError(new RarsSimulator().encode(Arrays.asList("nope x1")).get(0), "\"nope\" is not a recognized operator");

        // The CSR number is unsigned, so cycle is 0xc00 where addi reads the same bits as -1024. The csr*i
        // forms keep a 5-bit unsigned immediate where rs1 would be.
        List<Map<String, Object>> csr = new RarsSimulator().encode(Arrays.asList(
                "rdcycle t0", "rdinstreth a0", "csrw t1, fcsr", "csrrc t1, 0x800, t2", "csrrwi t0, 0x300, 5", "csrsi uie, 8",
                "csrrci t0, 0xfff, 31", "addi t0, t0, -1024", "wfi"));
        requireWord(csr.get(0), 0, "0xc00022f3", "I", "opcode", 0x73, "rd", 5, "funct3", 2, "rs1", 0, "csr", 0xc00);
        requireWord(csr.get(1), 0, "0xc8202573", "I", "opcode", 0x73, "rd", 10, "funct3", 2, "rs1", 0, "csr", 0xc82);
        requireWord(csr.get(2), 0, "0x00331073", "I", "opcode", 0x73, "rd", 0, "funct3", 1, "rs1", 6, "csr", 3);
        requireWord(csr.get(3), 0, "0x8003b373", "I", "opcode", 0x73, "rd", 6, "funct3", 3, "rs1", 7, "csr", 0x800);
        requireWord(csr.get(4), 0, "0x3002d2f3", "I", "opcode", 0x73, "rd", 5, "funct3", 5, "uimm", 5, "csr", 0x300);
        requireWord(csr.get(5), 0, "0x00446073", "I", "opcode", 0x73, "rd", 0, "funct3", 6, "uimm", 8, "csr", 4);
        requireWord(csr.get(6), 0, "0xfffff2f3", "I", "opcode", 0x73, "rd", 5, "funct3", 7, "uimm", 31, "csr", 0xfff);
        requireWord(csr.get(7), 0, "0xc0028293", "I", "opcode", 0x13, "rd", 5, "funct3", 0, "rs1", 5, "imm", -1024);
        requireWord(csr.get(8), 0, "0x10500073", "I", "opcode", 0x73, "rd", 0, "funct3", 0, "rs1", 0, "imm", 0x105);

        String countMessage = "Between 1 and 200 instructions are needed";
        requireThrows(IllegalArgumentException.class, () -> new RarsSimulator().encode(Collections.emptyList()), countMessage, "no instructions");
        requireThrows(IllegalArgumentException.class, () -> new RarsSimulator().encode(Collections.nCopies(201, "nop")), countMessage, "too many instructions");
        requireThrows(IllegalArgumentException.class, () -> new RarsSimulator().encode(Arrays.asList("nop", "nop\nnop")),
                "Instruction 2 spans more than one line", "instruction with a line break");

        // Every word RARS can assemble has an opcode the decoder knows.
        for (Instruction instruction : Globals.instructionSet.getInstructionList()) {
            if (instruction instanceof BasicInstruction) InstructionDecoder.decode(((BasicInstruction) instruction).getOpcodeMatch());
        }
        requireThrows(IllegalArgumentException.class, () -> InstructionDecoder.decode(0x0000007f),
                "No known format for opcode 0x7f in 0x0000007f", "unknown opcode");
    }

    private static void requireWord(Map<String, Object> entry, int index, String hex, String format, Object... fields) {
        String name = entry.get("source") + " word " + index;
        require(!entry.containsKey("error"), name + ": " + entry.get("error"));
        Map<?, ?> word = (Map<?, ?>) ((List<?>) entry.get("words")).get(index);
        require(hex.equals(word.get("hex")), name + " hex " + word.get("hex"));
        require(format.equals(word.get("format")), name + " format " + word.get("format"));
        Map<String, Object> expected = new LinkedHashMap<>();
        for (int field = 0; field < fields.length; field += 2) expected.put((String) fields[field], fields[field + 1]);
        require(new ArrayList<>(expected.entrySet()).equals(new ArrayList<>(((Map<?, ?>) word.get("fields")).entrySet())), name + " fields " + word.get("fields"));
    }

    private static void requireError(Map<String, Object> entry, String message) {
        require(!entry.containsKey("words") && String.valueOf(entry.get("error")).contains(message), entry.get("source") + " error " + entry.get("error"));
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
