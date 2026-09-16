package dev.rarsmcp.sim;

import java.util.Arrays;
import java.util.Collections;
import java.util.Map;

public final class RarsSimulatorSelfTest {
    public static void main(String[] args) throws Exception {
        RarsSimulator simulator = new RarsSimulator();
        simulator.load(Arrays.asList("tests/fixtures/debug.asm"), Collections.emptyList(), "");
        Map<String, Object> initial = simulator.snapshot();
        long initialPc = ((Number) initial.get("programCounter")).longValue();
        simulator.step();
        require(((Number) simulator.snapshot().get("programCounter")).longValue() == initialPc + 4, "step");
        simulator.setRegister("a0", 41);
        require(((Number) simulator.readRegister("a0")).intValue() == 41, "register write");
        simulator.writeMemory(0x10010000, 4, 1234);
        require(((Number) simulator.readMemory(0x10010000, 4)).intValue() == 1234, "memory write");
        simulator.backstep();
        require(((Number) simulator.snapshot().get("programCounter")).longValue() == initialPc, "backstep");
        simulator.reset();
        require(((Number) simulator.snapshot().get("programCounter")).longValue() == initialPc, "reset");
        System.out.println("RarsSimulatorSelfTest PASS");
    }

    private static void require(boolean value, String name) {
        if (!value) throw new AssertionError(name);
    }
}
