package dev.rarsmcp.sim;

import dev.rarsmcp.protocol.Words;

import rars.AssemblyException;
import rars.ErrorMessage;
import rars.ProgramStatement;
import rars.api.Options;
import rars.api.Program;
import rars.util.Binary;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// Encodes instructions with RARS's own assembler, so each word is the one RARS would run. The
// instructions are assembled as one program, one after another, so one can use a label on another.
final class InstructionEncoder {
    private static final int MAX_INSTRUCTIONS = 200;
    // RARS takes only a label as a branch or jump target. A number there is a byte offset from the
    // instruction, the value its immediate encodes, and is replaced by a label placed at that offset.
    private static final Pattern NUMERIC_TARGET = Pattern.compile("(?i)^((?:\\s*[\\w.$]+\\s*:)*\\s*"
            + "(?:b|beq|bne|blt|bge|bltu|bgeu|bgt|ble|bgtu|bleu|beqz|bnez|bltz|bgez|bgtz|blez|j|jal|call|tail)\\s+(?:[^#]*,)?\\s*)"
            + "([-+]?(?:0x[0-9a-f]+|\\d+))(\\s*(?:#.*)?)$");
    private static final String TARGET_LABEL = "__rars_mcp_target_";

    private final List<String> sources;
    // Each instruction as assembled: the source, with a numeric target replaced by its label.
    private final List<String> lines = new ArrayList<>();
    // The numeric target of each instruction that has one, as written.
    private final Map<Integer, String> numericTargets = new TreeMap<>();
    // Where each numeric target's label sits, once its instruction's address is known.
    private final Map<Integer, Integer> targets = new TreeMap<>();
    private final Map<Integer, String> errors = new HashMap<>();
    // The instruction each line of the generated program belongs to.
    private final List<Integer> owners = new ArrayList<>();

    private InstructionEncoder(List<String> sources) {
        this.sources = sources;
        for (int index = 0; index < sources.size(); index++) {
            Matcher target = NUMERIC_TARGET.matcher(sources.get(index));
            if (!target.matches()) {
                lines.add(sources.get(index));
                continue;
            }
            String offset = target.group(2);
            try {
                // An odd offset loses its low bit in the encoding, which RARS does without a word.
                if (Binary.stringToInt(offset) % 2 != 0) errors.put(index, "Branch and jump offsets must be even, not " + offset);
            } catch (NumberFormatException tooLarge) {
                errors.put(index, "Offset " + offset + " does not fit in 32 bits");
            }
            numericTargets.put(index, offset);
            lines.add(target.group(1) + TARGET_LABEL + index + target.group(3));
        }
    }

    // { source, basic, words } for each instruction, or { source, error } for one RARS cannot assemble.
    static List<Map<String, Object>> encode(List<String> sources) throws Exception {
        if (sources.isEmpty() || sources.size() > MAX_INSTRUCTIONS) {
            throw new IllegalArgumentException("Between 1 and " + MAX_INSTRUCTIONS + " instructions are needed");
        }
        for (int index = 0; index < sources.size(); index++) {
            String source = sources.get(index);
            if (source.contains("\n") || source.contains("\r")) throw new IllegalArgumentException("Instruction " + (index + 1) + " spans more than one line");
        }
        return new InstructionEncoder(sources).run();
    }

    // Assembles until no instruction fails and every numeric target is in place. An instruction that
    // fails is left out of the next attempt, so the others still encode.
    private List<Map<String, Object>> run() throws Exception {
        while (true) {
            Program program = new Program(new Options());
            try {
                program.assembleString(program());
            } catch (AssemblyException failure) {
                recordErrors(failure);
                // Leaving an instruction out moves the ones after it, and so their targets.
                targets.clear();
                continue;
            }
            Map<Integer, List<ProgramStatement>> statements = new HashMap<>();
            for (ProgramStatement statement : RarsSimulator.code(program).getMachineList()) {
                statements.computeIfAbsent(owners.get(statement.getSourceLine() - 1), owner -> new ArrayList<>()).add(statement);
            }
            if (!placeTargets(statements)) return results(statements);
        }
    }

    // Each instruction on its own line, after a .text of its own so a directive cannot move the ones after it
    // out of the text segment. A numeric target's label sits on the line before its instruction, a branch to
    // itself, until the instruction's address is known; it then moves to that address plus the offset.
    private String program() {
        owners.clear();
        StringBuilder text = new StringBuilder();
        for (int index = 0; index < lines.size(); index++) {
            if (errors.containsKey(index)) continue;
            line(text, index, ".text");
            if (numericTargets.containsKey(index) && !targets.containsKey(index)) line(text, index, TARGET_LABEL + index + ":");
            line(text, index, lines.get(index));
        }
        for (Map.Entry<Integer, Integer> target : targets.entrySet()) {
            line(text, target.getKey(), ".text " + Words.address(target.getValue()));
            line(text, target.getKey(), TARGET_LABEL + target.getKey() + ":");
        }
        return text.toString();
    }

    private void line(StringBuilder text, int owner, String line) {
        text.append(line).append('\n');
        owners.add(owner);
    }

    // Each instruction's error messages, with any target label put back as the number it replaced.
    private void recordErrors(AssemblyException failure) {
        String report = failure.errors().generateErrorReport().trim();
        Map<Integer, List<String>> messages = new TreeMap<>();
        for (ErrorMessage error : failure.errors().getErrorMessages()) {
            if (error.isWarning()) continue;
            if (error.getLine() < 1 || error.getLine() > owners.size()) throw new IllegalStateException(report);
            int owner = owners.get(error.getLine() - 1);
            String message = error.getMessage();
            if (numericTargets.containsKey(owner)) message = message.replace(TARGET_LABEL + owner, numericTargets.get(owner));
            messages.computeIfAbsent(owner, key -> new ArrayList<>()).add(message);
        }
        if (messages.isEmpty()) throw new IllegalStateException(report);
        for (Map.Entry<Integer, List<String>> entry : messages.entrySet()) errors.put(entry.getKey(), String.join("\n", entry.getValue()));
    }

    // Moves each numeric target still on its own instruction to that instruction's address plus the offset.
    // Returns whether any moved, which means assembling again.
    private boolean placeTargets(Map<Integer, List<ProgramStatement>> statements) {
        boolean placed = false;
        for (Map.Entry<Integer, String> target : numericTargets.entrySet()) {
            int index = target.getKey();
            if (errors.containsKey(index) || targets.containsKey(index)) continue;
            targets.put(index, statements.get(index).get(0).getAddress() + Binary.stringToInt(target.getValue()));
            placed = true;
        }
        return placed;
    }

    private List<Map<String, Object>> results(Map<Integer, List<ProgramStatement>> statements) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (int index = 0; index < sources.size(); index++) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("source", sources.get(index));
            List<ProgramStatement> assembled = statements.getOrDefault(index, Collections.emptyList());
            if (errors.containsKey(index)) {
                entry.put("error", errors.get(index));
            } else if (assembled.isEmpty()) {
                entry.put("error", "Not an instruction"); // a label, comment or directive on its own
            } else {
                List<String> basic = new ArrayList<>();
                List<Map<String, Object>> words = new ArrayList<>();
                for (ProgramStatement statement : assembled) {
                    basic.add(statement.getPrintableBasicAssemblyStatement().trim());
                    words.add(InstructionDecoder.decode(statement.getBinaryStatement()));
                }
                entry.put("basic", basic);
                entry.put("words", words);
            }
            result.add(entry);
        }
        return result;
    }
}
