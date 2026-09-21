package dev.rarsmcp.sim;

import dev.rarsmcp.protocol.Words;

import rars.AssemblyException;
import rars.ProgramStatement;
import rars.RISCVprogram;
import rars.SimulationException;
import rars.Globals;
import rars.api.Options;
import rars.api.Program;
import rars.assembler.Symbol;
import rars.assembler.SymbolTable;
import rars.riscv.hardware.ControlAndStatusRegisterFile;
import rars.riscv.hardware.FloatingPointRegisterFile;
import rars.riscv.hardware.Memory;
import rars.riscv.hardware.RegisterFile;
import rars.simulator.BackStepper;
import rars.simulator.Simulator;

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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class RarsSimulator {
    private static final Pattern NUMBER = Pattern.compile("-?(0x[0-9a-fA-F]+|\\d+)");
    private static final Pattern FILE_LINE = Pattern.compile("(.+):(\\d+)");

    private Program program;
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

    private void setup() throws Exception {
        program.setup(new ArrayList<>(arguments), stdin);
        RISCVprogram code = code();
        code.getBackStepper().setEnabled(true);
        Globals.program = code;
        status = "paused";
        stopReason = null;
        exception = null;
    }

    public synchronized Map<String, Object> step() throws Exception {
        ensureLoaded();
        if (simulateOne()) {
            status = "paused";
            stopReason = "step";
        }
        return snapshot();
    }

    public synchronized Map<String, Object> runUntilStop(int maximumSteps) throws Exception {
        ensureLoaded();
        for (int count = 0; count < maximumSteps; count++) {
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
        if (NUMBER.matcher(location).matches()) return (int) (long) Long.decode(location);
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

    public synchronized void setRegister(String name, int value) {
        ensureLoaded();
        if (name.equals("pc")) { RegisterFile.setProgramCounter(value); return; }
        requireKnownRegister(name);
        program.setRegisterValue(name, value);
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
        for (ProgramStatement statement : code().getMachineList()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("address", Words.address(statement.getAddress()));
            entry.put("code", Words.address(statement.getBinaryStatement()));
            entry.put("basic", statement.getPrintableBasicAssemblyStatement().trim());
            entry.put("source", statement.getSource().trim());
            entry.put("file", statement.getSourceFile());
            entry.put("line", statement.getSourceLine());
            result.add(entry);
        }
        return result;
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

    public synchronized void writeMemory(int address, int width, long value) throws Exception {
        ensureLoaded();
        switch (width) {
            case 1: program.getMemory().setByte(address, (int) value); break;
            case 2: program.getMemory().setHalf(address, (int) value); break;
            case 4: program.getMemory().setWord(address, (int) value); break;
            case 8: program.getMemory().setDoubleWord(address, value); break;
            default: throw new IllegalArgumentException("Width must be 1, 2, 4, or 8");
        }
    }

    public synchronized Map<String, Object> snapshot() {
        ensureLoaded();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("status", status);
        result.put("programCounter", Words.address(RegisterFile.getProgramCounter()));
        result.put("stdout", program.getSTDOUT());
        result.put("stderr", program.getSTDERR());
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

    private RISCVprogram code() throws Exception {
        Field codeField = Program.class.getDeclaredField("code");
        codeField.setAccessible(true);
        return (RISCVprogram) codeField.get(program);
    }

    private void ensureLoaded() {
        if (program == null) throw new IllegalStateException("No program is loaded");
    }
}
