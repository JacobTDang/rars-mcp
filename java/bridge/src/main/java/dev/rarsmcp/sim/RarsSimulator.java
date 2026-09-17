package dev.rarsmcp.sim;

import rars.RISCVprogram;
import rars.ProgramStatement;
import rars.Globals;
import rars.api.Options;
import rars.api.Program;
import rars.riscv.hardware.Memory;
import rars.riscv.hardware.RegisterFile;
import rars.simulator.BackStepper;
import rars.simulator.Simulator;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

public final class RarsSimulator {
    private Program program;
    private Options options;
    private List<String> files = new ArrayList<>();
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
        program.assemble(new ArrayList<>(files), files.get(0));
        setup();
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
    public synchronized Object readRegister(String name) { ensureLoaded(); return Integer.toUnsignedLong(program.getRegisterValue(name)); }
    public synchronized long readInstruction(int address) throws Exception {
        for (ProgramStatement statement : code().getMachineList()) if (statement.getAddress() == address) return Integer.toUnsignedLong(statement.getBinaryStatement());
        throw new IllegalArgumentException("No instruction at address " + Integer.toUnsignedString(address));
    }
    public synchronized void setRegister(String name, int value) { ensureLoaded(); program.setRegisterValue(name, value); }

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
