package dev.rarsmcp.sim;

import dev.rarsmcp.protocol.MiniJson;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class TraceMain {
    private TraceMain() {}
    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("usage: TraceMain SOURCE OUTPUT MAX_STEPS");
        int maximum = Integer.parseInt(args[2]);
        RarsSimulator simulator = new RarsSimulator();
        simulator.load(List.of(args[0]), List.of(), "");
        List<String> records = new ArrayList<>();
        for (int order = 0; order < maximum; order++) {
            Map<String, Object> before = simulator.snapshot();
            long pc = ((Number) before.get("programCounter")).longValue();
            long instruction = simulator.readInstruction((int) pc);
            long[] registers = new long[32];
            for (int index = 0; index < 32; index++) registers[index] = ((Number) simulator.readRegister("x" + index)).longValue();
            Map<String, Object> after = simulator.step();
            Map<String, Object> event = new LinkedHashMap<>();
            event.put("retireOrder", order); event.put("valid", true);
            event.put("instructionBits", String.format("0x%08x", instruction)); event.put("instructionWidth", (instruction & 3) == 3 ? 32 : 16);
            event.put("pcBefore", String.format("0x%x", pc)); event.put("pcAfter", String.format("0x%x", ((Number) after.get("programCounter")).longValue()));
            for (int index = 1; index < 32; index++) {
                long value = ((Number) simulator.readRegister("x" + index)).longValue();
                if (value != registers[index]) { Map<String, Object> destination = new LinkedHashMap<>(); destination.put("address", index); destination.put("value", String.format("0x%x", value)); event.put("destinationRegister", destination); break; }
            }
            event.put("halt", "terminated".equals(after.get("status")));
            records.add(MiniJson.stringify(event));
            if ("terminated".equals(after.get("status"))) break;
        }
        Files.writeString(Path.of(args[1]), String.join("\n", records) + "\n");
    }
}
