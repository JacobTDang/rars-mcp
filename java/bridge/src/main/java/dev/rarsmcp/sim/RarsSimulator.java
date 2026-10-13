package dev.rarsmcp.sim;

import dev.rarsmcp.protocol.Words;

import rars.AssemblyException;
import rars.ProgramStatement;
import rars.RISCVprogram;
import rars.SimulationException;
import rars.Globals;
import rars.Settings;
import rars.api.Options;
import rars.api.Program;
import rars.assembler.Symbol;
import rars.assembler.SymbolTable;
import rars.riscv.hardware.AddressErrorException;
import rars.riscv.hardware.ControlAndStatusRegisterFile;
import rars.riscv.hardware.FloatingPointRegisterFile;
import rars.riscv.hardware.Memory;
import rars.riscv.hardware.Register;
import rars.riscv.hardware.RegisterFile;
import rars.simulator.BackStepper;
import rars.simulator.Simulator;
import rars.util.SystemIO;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class RarsSimulator {
    private static final Pattern NUMBER = Pattern.compile("-?(0x[0-9a-fA-F]+|\\d+)");
    private static final Pattern FILE_LINE = Pattern.compile("(.+):(\\d+)");
    private static final int MAX_INSTRUCTION_WINDOW = 200;

    private final long maxOutputBytes;
    private Program program;
    private ProgramOutput output;
    private Options options;
    private List<String> files = new ArrayList<>();
    private List<RISCVprogram> sources = new ArrayList<>();
    private List<String> arguments = new ArrayList<>();
    private String stdin = "";
    private String status = "ready";
    // Why the last step, continue or backstep stopped; null until one runs.
    private String stopReason;
    private String exception;
    private final Set<Integer> breakpoints = new TreeSet<>();

    // maxOutputBytes: the most stdout and stderr, together, kept from one run.
    public RarsSimulator(long maxOutputBytes) {
        if (maxOutputBytes <= 0) throw new IllegalArgumentException("The output limit must be a positive number of bytes, not " + maxOutputBytes);
        this.maxOutputBytes = maxOutputBytes;
    }

    public synchronized void load(List<String> sourceFiles, List<String> programArguments, String standardInput) throws Exception {
        options = new Options();
        options.maxSteps = 1;
        options.startAtMain = true;
        program = new Program(options);
        files = new ArrayList<>(sourceFiles);
        arguments = new ArrayList<>(programArguments);
        stdin = standardInput;
        sources = assemble(files);
        setup();
    }

    // Same steps as Program.assemble(files, main), but keeps each file's program
    // so its local symbol table is still reachable after assembly.
    private ArrayList<RISCVprogram> assemble(List<String> sourceFiles) throws Exception {
        try {
            ArrayList<RISCVprogram> programs = code().prepareFilesForAssembly(new ArrayList<>(sourceFiles), sourceFiles.get(0), null);
            Method assemble = Program.class.getDeclaredMethod("assemble", ArrayList.class);
            assemble.setAccessible(true);
            assemble.invoke(program, programs);
            return programs;
        } catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof AssemblyException) throw assemblyFailure((AssemblyException) cause);
            if (cause instanceof Exception) throw (Exception) cause;
            throw (Error) cause;
        } catch (AssemblyException error) {
            throw assemblyFailure(error);
        }
    }

    // AssemblyException carries no message of its own; the details are in its error list.
    private static IllegalArgumentException assemblyFailure(AssemblyException error) {
        return new IllegalArgumentException(error.errors().generateErrorReport().trim());
    }

    // Starts a run: load and reset both come here, and neither can be stepped back past.
    private void setup() throws Exception {
        program.setup(new ArrayList<>(arguments), stdin);
        captureOutput();
        RISCVprogram code = code();
        clearHistory(code);
        Globals.program = code;
        status = "paused";
        stopReason = null;
        exception = null;
    }

    public synchronized Map<String, Object> step() throws Exception {
        ensureRunnable();
        if (simulateOne()) {
            status = "paused";
            stopReason = "step";
        }
        return snapshot();
    }

    // pauseRequested is asked before each instruction, and a yes stops the run with stopReason "paused".
    public synchronized Map<String, Object> runUntilStop(int maximumSteps, BooleanSupplier pauseRequested) throws Exception {
        ensureRunnable();
        for (int count = 0; count < maximumSteps; count++) {
            if (pauseRequested.getAsBoolean()) {
                status = "paused";
                stopReason = "paused";
                return snapshot();
            }
            if (!simulateOne()) return snapshot();
            if (breakpoints.contains(RegisterFile.getProgramCounter())) {
                status = "paused";
                stopReason = "breakpoint";
                return snapshot();
            }
        }
        status = "paused";
        stopReason = "step_limit";
        return snapshot();
    }

    // Runs one instruction. Returns false, with status and stopReason set, when the program stopped by itself.
    private boolean simulateOne() {
        Simulator.Reason reason;
        try {
            reason = program.simulate();
        } catch (SimulationException error) {
            status = "terminated";
            stopReason = "exception";
            exception = error.error() != null ? error.error().getMessage() : error.getMessage();
            return false;
        }
        switch (reason) {
            case MAX_STEPS: return true;
            case BREAKPOINT: status = "paused"; stopReason = "breakpoint"; return false;
            case NORMAL_TERMINATION: status = "terminated"; stopReason = "exited"; return false;
            case CLIFF_TERMINATION: status = "terminated"; stopReason = "ran_off_end"; return false;
            case EXCEPTION: status = "terminated"; stopReason = "exception"; return false;
            default: throw new IllegalStateException("Unexpected RARS stop reason: " + reason);
        }
    }

    public synchronized Map<String, Object> backstep() throws Exception {
        ensureLoaded();
        BackStepper backStepper = backStepper();
        if (backStepper.empty()) throw new IllegalStateException("No backstep history");
        Memory previous = Memory.swapInstance(program.getMemory());
        try { backStepper.backStep(); } finally { Memory.swapInstance(previous); }
        status = "paused";
        stopReason = "backstep";
        exception = null;
        return snapshot();
    }

    public synchronized Map<String, Object> reset() throws Exception { setup(); return snapshot(); }

    public synchronized Map<String, Object> terminate() {
        ensureLoaded();
        status = "terminated";
        stopReason = "terminated";
        return snapshot();
    }

    // A terminated program would otherwise run whatever memory follows its last instruction.
    private void ensureRunnable() {
        ensureLoaded();
        if (status.equals("terminated")) {
            throw new IllegalStateException("The program has terminated; reset the session to run it again");
        }
    }
    public synchronized Map<String, Object> addBreakpoint(String location) throws Exception {
        ensureLoaded();
        breakpoints.add(resolveLocation(location));
        return snapshot();
    }

    public synchronized Map<String, Object> removeBreakpoint(String location) throws Exception {
        ensureLoaded();
        breakpoints.remove(resolveLocation(location));
        return snapshot();
    }

    // A breakpoint location: an address, file:line, or a code label.
    private int resolveLocation(String location) throws Exception {
        if (NUMBER.matcher(location).matches()) return Words.parseAddress(location);
        Matcher fileLine = FILE_LINE.matcher(location);
        if (fileLine.matches()) return addressOfLine(fileLine.group(1), Integer.parseInt(fileLine.group(2)), location);
        return addressOfLabel(location);
    }

    // The first instruction assembled from that line; a file matches by its full path or a trailing part of it.
    private int addressOfLine(String file, int line, String location) throws Exception {
        for (ProgramStatement statement : code().getMachineList()) {
            String source = statement.getSourceFile();
            if (statement.getSourceLine() == line && (source.equals(file) || source.endsWith(File.separator + file))) {
                return statement.getAddress();
            }
        }
        throw new IllegalArgumentException("No instruction at " + location);
    }

    private int addressOfLabel(String label) {
        Set<Integer> addresses = new TreeSet<>();
        boolean dataLabel = false;
        for (SymbolTable table : symbolTables()) {
            for (Symbol symbol : table.getTextSymbols()) if (symbol.getName().equals(label)) addresses.add(symbol.getAddress());
            for (Symbol symbol : table.getDataSymbols()) if (symbol.getName().equals(label)) dataLabel = true;
        }
        if (addresses.size() == 1) return addresses.iterator().next();
        if (addresses.size() > 1) throw new IllegalArgumentException("Label " + label + " is defined in more than one file; use file:line instead");
        if (dataLabel) throw new IllegalArgumentException(label + " is a data label, not a code label");
        throw new IllegalArgumentException("Unknown label: " + label);
    }

    // Each source file's local labels, then the .globl labels.
    private List<SymbolTable> symbolTables() {
        List<SymbolTable> tables = new ArrayList<>();
        for (RISCVprogram source : sources) tables.add(source.getLocalSymbolTable());
        tables.add(Globals.symbolTable);
        return tables;
    }
    public synchronized Object readRegister(String name) {
        ensureLoaded();
        if (name.equals("pc")) return Integer.toUnsignedLong(RegisterFile.getProgramCounter());
        requireKnownRegister(name);
        return Integer.toUnsignedLong(program.getRegisterValue(name));
    }

    synchronized void setRegister(String name, int value) {
        ensureLoaded();
        if (name.equals("pc")) { RegisterFile.setProgramCounter(value); return; }
        requireWritableRegister(name);
        program.setRegisterValue(name, value);
    }

    // RARS would store a value in x0, and the program would then read it back.
    private static void requireWritableRegister(String name) {
        requireKnownRegister(name);
        Register integer = RegisterFile.getRegister(name);
        if (integer != null && integer.getNumber() == 0) {
            throw new IllegalArgumentException("Cannot write " + name + ": x0 is hard-wired to zero");
        }
    }

    // RARS looks names up in the integer, floating-point, then CSR files and
    // throws a bare NullPointerException when none of them has the name.
    private static void requireKnownRegister(String name) {
        if (RegisterFile.getRegister(name) == null && FloatingPointRegisterFile.getRegister(name) == null
                && ControlAndStatusRegisterFile.getRegister(name) == null) {
            throw new IllegalArgumentException("Unknown register: " + name);
        }
    }

    public synchronized List<Map<String, Object>> symbols() {
        ensureLoaded();
        List<Map<String, Object>> result = new ArrayList<>();
        for (RISCVprogram source : sources) addSymbols(result, source.getLocalSymbolTable(), false);
        addSymbols(result, Globals.symbolTable, true);
        result.sort(Comparator.comparing(symbol -> (String) symbol.get("address")));
        return result;
    }

    // The assembled text segment, one entry per machine instruction.
    public synchronized List<Map<String, Object>> instructions() throws Exception {
        ensureLoaded();
        List<Map<String, Object>> result = new ArrayList<>();
        for (ProgramStatement statement : code().getMachineList()) result.add(instruction(statement));
        return result;
    }

    // count instructions centred on location, fewer at either end of the program;
    // an even count puts the extra one after it.
    public synchronized List<Map<String, Object>> instructionsAround(String location, int count) throws Exception {
        ensureLoaded();
        if (count < 1 || count > MAX_INSTRUCTION_WINDOW) {
            throw new IllegalArgumentException("count must be between 1 and " + MAX_INSTRUCTION_WINDOW);
        }
        List<ProgramStatement> statements = statementsByAddress();
        int address = windowAddress(location);
        int below = 0;
        while (below < statements.size() && Integer.compareUnsigned(statements.get(below).getAddress(), address) < 0) below++;
        if (below < statements.size() && statements.get(below).getAddress() == address) {
            return window(statements, below - (count - 1) / 2, below + count / 2);
        }
        // pc with no instruction, as after the program exits: the window ends at the last instruction below it.
        if (location.equals("pc") && below > 0) return window(statements, below - count, below - 1);
        String at = NUMBER.matcher(location).matches() ? Words.address(address) : location + " (" + Words.address(address) + ")";
        throw new IllegalArgumentException("No instruction at " + at);
    }

    // Every instruction from one location to another, both included.
    public synchronized List<Map<String, Object>> instructionsBetween(String from, String to) throws Exception {
        ensureLoaded();
        int start = windowAddress(from);
        int end = windowAddress(to);
        if (Integer.compareUnsigned(start, end) > 0) throw new IllegalArgumentException(from + " comes after " + to);
        List<Map<String, Object>> result = new ArrayList<>();
        for (ProgramStatement statement : statementsByAddress()) {
            int address = statement.getAddress();
            if (Integer.compareUnsigned(address, start) >= 0 && Integer.compareUnsigned(address, end) <= 0) result.add(instruction(statement));
        }
        if (result.size() > MAX_INSTRUCTION_WINDOW) {
            throw new IllegalArgumentException("The range " + from + " to " + to + " holds " + result.size()
                    + " instructions; the limit is " + MAX_INSTRUCTION_WINDOW);
        }
        return result;
    }

    // The statements from first to last, both included, clipped to the program.
    private static List<Map<String, Object>> window(List<ProgramStatement> statements, int first, int last) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (int index = Math.max(0, first); index <= Math.min(statements.size() - 1, last); index++) result.add(instruction(statements.get(index)));
        return result;
    }

    // pc, or any location a breakpoint accepts.
    private int windowAddress(String location) throws Exception {
        return location.equals("pc") ? RegisterFile.getProgramCounter() : resolveLocation(location);
    }

    // The machine list follows source order, which need not be address order (.ktext, or .text with an address).
    private List<ProgramStatement> statementsByAddress() throws Exception {
        List<ProgramStatement> statements = new ArrayList<>(code().getMachineList());
        statements.sort((left, right) -> Integer.compareUnsigned(left.getAddress(), right.getAddress()));
        return statements;
    }

    private static Map<String, Object> instruction(ProgramStatement statement) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("address", Words.address(statement.getAddress()));
        entry.put("code", Words.address(statement.getBinaryStatement()));
        entry.put("basic", statement.getPrintableBasicAssemblyStatement().trim());
        entry.put("source", statement.getSource().trim());
        entry.put("file", statement.getSourceFile());
        entry.put("line", statement.getSourceLine());
        return entry;
    }

    private static void addSymbols(List<Map<String, Object>> result, SymbolTable table, boolean global) {
        for (Symbol symbol : table.getTextSymbols()) result.add(symbol(symbol, "text", global));
        for (Symbol symbol : table.getDataSymbols()) result.add(symbol(symbol, "data", global));
    }

    private static Map<String, Object> symbol(Symbol symbol, String type, boolean global) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", symbol.getName());
        result.put("address", Words.address(symbol.getAddress()));
        result.put("type", type);
        result.put("global", global);
        return result;
    }

    // Assembling resets RARS's global symbol table and program counter, which a loaded program depends on.
    public synchronized List<Map<String, Object>> encode(List<String> instructions) throws Exception {
        if (program != null) throw new IllegalStateException("Encoding needs a bridge with no program loaded");
        return InstructionEncoder.encode(instructions);
    }

    public synchronized Object readMemory(int address, int width) throws Exception {
        ensureLoaded();
        switch (width) {
            case 1: return program.getMemory().getByte(address);
            case 2: return program.getMemory().getHalf(address);
            case 4: return Integer.toUnsignedLong(program.getMemory().getWord(address));
            case 8: return program.getMemory().getDoubleWord(address);
            default: throw new IllegalArgumentException("Width must be 1, 2, 4, or 8");
        }
    }

    // Writes registers, then memory, after checking every name, address and value, so a rejected
    // request changes nothing. registers maps a name to a value; each memory write is { address, width, value }.
    public synchronized void modify(Map<?, ?> registers, List<?> memory) throws Exception {
        ensureLoaded();
        Map<String, Integer> registerValues = new LinkedHashMap<>();
        for (Map.Entry<?, ?> entry : registers.entrySet()) {
            String name = String.valueOf(entry.getKey());
            if (!name.equals("pc")) requireWritableRegister(name);
            registerValues.put(name, (int) Words.parseValue(entry.getValue(), 4, name));
        }
        List<long[]> writes = new ArrayList<>();
        for (Object item : memory) {
            if (!(item instanceof Map)) throw new IllegalArgumentException("Each memory write must be an object");
            Map<?, ?> write = (Map<?, ?>) item;
            int address = Words.parseAddress(write.get("address"));
            int width = width(write.get("width"));
            long value = Words.parseValue(write.get("value"), width, Words.address(address));
            checkStore(address, width);
            writes.add(new long[] { address, width, value });
        }
        for (Map.Entry<String, Integer> entry : registerValues.entrySet()) setRegister(entry.getKey(), entry.getValue());
        for (long[] write : writes) writeMemory((int) write[0], (int) write[1], write[2]);
    }

    private static int width(Object value) {
        String text = String.valueOf(value);
        if (!text.matches("[1248]")) throw new IllegalArgumentException("Width must be 1, 2, 4, or 8");
        return Integer.parseInt(text);
    }

    // The checks RARS makes when it stores width bytes, with its messages, so all of them can pass before
    // anything is written. RARS stores 8 bytes as two words, the high one first, and does not check that
    // they are aligned; here they must be on a word boundary, as RARS needs to read them back.
    private static void checkStore(int address, int width) throws AddressErrorException {
        if (width == 2 && address % 2 != 0) {
            throw new AddressErrorException("store address not aligned on halfword boundary ", SimulationException.STORE_ADDRESS_MISALIGNED, address);
        }
        if (width >= 4 && !Memory.wordAligned(address)) {
            throw new AddressErrorException("Store address not aligned to word boundary ", SimulationException.STORE_ADDRESS_MISALIGNED, address);
        }
        if (width == 8) checkStoreSegment(address + 4);
        checkStoreSegment(address);
    }

    // Where Memory.set accepts an aligned store.
    private static void checkStoreSegment(int address) throws AddressErrorException {
        if (Memory.inDataSegment(address) || (address > Memory.stackLimitAddress && address <= Memory.stackBaseAddress)) return;
        if (address >= Memory.memoryMapBaseAddress && address < Memory.memoryMapLimitAddress) return;
        if (!Memory.inTextSegment(address)) {
            throw new AddressErrorException("address out of range ", SimulationException.STORE_ACCESS_FAULT, address);
        }
        if (!Globals.getSettings().getBooleanSetting(Settings.Bool.SELF_MODIFYING_CODE_ENABLED)) {
            throw new AddressErrorException("Cannot write directly to text segment!", SimulationException.STORE_ACCESS_FAULT, address);
        }
    }

    synchronized void writeMemory(int address, int width, long value) throws Exception {
        ensureLoaded();
        switch (width) {
            case 1: program.getMemory().setByte(address, (int) value); break;
            case 2: program.getMemory().setHalf(address, (int) value); break;
            case 4: program.getMemory().setWord(address, (int) value); break;
            case 8: program.getMemory().setDoubleWord(address, value); break;
            default: throw new IllegalArgumentException("Width must be 1, 2, 4, or 8");
        }
    }

    // The machine state, with the output written since the previous snapshot.
    public synchronized Map<String, Object> snapshot() {
        ensureLoaded();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("status", status);
        result.put("programCounter", Words.address(RegisterFile.getProgramCounter()));
        result.putAll(output.take(status.equals("terminated")));
        result.put("exitCode", program.getExitCode());
        if (stopReason != null) result.put("stopReason", stopReason);
        if (exception != null) result.put("exception", exception);
        List<String> breakpointAddresses = new ArrayList<>();
        for (int breakpoint : breakpoints) breakpointAddresses.add(Words.address(breakpoint));
        result.put("breakpoints", breakpointAddresses);
        return result;
    }

    private BackStepper backStepper() throws Exception {
        return code().getBackStepper();
    }

    // RARS's setup gives the program output buffers with no limit. These are the same streams, stdin
    // included, with a ProgramOutput for stdout and stderr.
    private void captureOutput() throws Exception {
        output = new ProgramOutput(maxOutputBytes);
        Field streams = Program.class.getDeclaredField("fds");
        streams.setAccessible(true);
        streams.set(program, new SystemIO.Data(new ByteArrayInputStream(stdin.getBytes()), output.stdout(), output.stderr()));
    }

    // A BackStepper cannot be emptied, so this gives the program a new one, as assembling it again would.
    private static void clearHistory(RISCVprogram code) throws Exception {
        BackStepper history = new BackStepper();
        history.setEnabled(true);
        Field field = RISCVprogram.class.getDeclaredField("backStepper");
        field.setAccessible(true);
        field.set(code, history);
    }

    private RISCVprogram code() throws Exception {
        return code(program);
    }

    static RISCVprogram code(Program program) throws Exception {
        Field codeField = Program.class.getDeclaredField("code");
        codeField.setAccessible(true);
        return (RISCVprogram) codeField.get(program);
    }

    private void ensureLoaded() {
        if (program == null) throw new IllegalStateException("No program is loaded");
    }
}
