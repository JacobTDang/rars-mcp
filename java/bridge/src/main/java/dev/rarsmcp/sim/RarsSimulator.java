package dev.rarsmcp.sim;

import rars.AssemblyException;
import rars.RISCVprogram;
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

public final class RarsSimulator {
    private Program program;
    private Options options;
    private List<String> files = new ArrayList<>();
    private List<RISCVprogram> sources = new ArrayList<>();
    private List<String> arguments = new ArrayList<>();
    private String stdin = "";
    private String status = "ready";
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
    }

    public synchronized Map<String, Object> step() throws Exception {
        ensureLoaded();
        Simulator.Reason reason = program.simulate();
        status = reason == Simulator.Reason.MAX_STEPS || reason == Simulator.Reason.BREAKPOINT ? "paused" : "terminated";
        return snapshot();
    }

    public synchronized Map<String, Object> runUntilStop(int maximumSteps) throws Exception {
        ensureLoaded();
        status = "running";
        for (int count = 0; count < maximumSteps; count++) {
            Simulator.Reason reason = program.simulate();
            if (reason != Simulator.Reason.MAX_STEPS) {
                status = reason == Simulator.Reason.BREAKPOINT ? "paused" : "terminated";
                return snapshot();
            }
            if (breakpoints.contains(RegisterFile.getProgramCounter())) {
                status = "paused";
                return snapshot();
            }
        }
        status = "paused";
        return snapshot();
    }

    public synchronized Map<String, Object> backstep() throws Exception {
        ensureLoaded();
        BackStepper backStepper = backStepper();
        if (backStepper.empty()) throw new IllegalStateException("No backstep history");
        Memory previous = Memory.swapInstance(program.getMemory());
        try { backStepper.backStep(); } finally { Memory.swapInstance(previous); }
        status = "paused";
        return snapshot();
    }

    public synchronized Map<String, Object> reset() throws Exception { setup(); return snapshot(); }
    public synchronized void addBreakpoint(int address) { breakpoints.add(address); }
    public synchronized void removeBreakpoint(int address) { breakpoints.remove(address); }
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
        result.sort(Comparator.comparingLong(symbol -> (Long) symbol.get("address")));
        return result;
    }

    private static void addSymbols(List<Map<String, Object>> result, SymbolTable table, boolean global) {
        for (Symbol symbol : table.getTextSymbols()) result.add(symbol(symbol, "text", global));
        for (Symbol symbol : table.getDataSymbols()) result.add(symbol(symbol, "data", global));
    }

    private static Map<String, Object> symbol(Symbol symbol, String type, boolean global) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("name", symbol.getName());
        result.put("address", Integer.toUnsignedLong(symbol.getAddress()));
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
        result.put("programCounter", Integer.toUnsignedLong(RegisterFile.getProgramCounter()));
        result.put("stdout", program.getSTDOUT());
        result.put("stderr", program.getSTDERR());
        result.put("exitCode", program.getExitCode());
        result.put("breakpoints", new ArrayList<>(breakpoints));
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
