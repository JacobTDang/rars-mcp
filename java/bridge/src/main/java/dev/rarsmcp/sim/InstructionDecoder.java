package dev.rarsmcp.sim;

import dev.rarsmcp.protocol.Words;

import rars.riscv.InstructionSet;

import java.util.LinkedHashMap;
import java.util.Map;

// Splits an instruction word into the fields of its format. The format comes from the opcode
// alone: RARS's own format labels file the shift-immediates under R and fcvt.d.s under R4.
final class InstructionDecoder {
    private InstructionDecoder() {}

    // { hex, format, fields }, every field a number and imm already put back together.
    static Map<String, Object> decode(int word) {
        String format = format(word);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("hex", Words.address(word));
        result.put("format", format);
        result.put("fields", fields(format, word));
        return result;
    }

    private static String format(int word) {
        switch (opcode(word)) {
            case 0x33: // add, sub, sll ... and the M extension
            case 0x3b: // addw, subw ... (RV64)
            case 0x53: // floating-point arithmetic, compares and conversions; funct3 holds the rounding mode
                return "R";
            case 0x43: case 0x47: case 0x4b: case 0x4f: // fmadd, fmsub, fnmsub, fnmadd
                return "R4";
            case 0x03: // integer loads
            case 0x07: // floating-point loads
            case 0x0f: // fence, fence.i
            case 0x13: // addi, slti ... and the shift-immediates
            case 0x1b: // addiw and its shift-immediates (RV64)
            case 0x67: // jalr
            case 0x73: // ecall, ebreak, uret, wfi and the CSR instructions, which keep the CSR number where imm would be
                return "I";
            case 0x23: case 0x27: return "S"; // integer and floating-point stores
            case 0x63: return "B";
            case 0x37: case 0x17: return "U"; // lui, auipc
            case 0x6f: return "J";
            default: throw new IllegalArgumentException(String.format("No known format for opcode 0x%02x in %s", opcode(word), Words.address(word)));
        }
    }

    private static Map<String, Object> fields(String format, int word) {
        switch (format) {
            case "R":
                return fields("opcode", opcode(word), "rd", rd(word), "funct3", funct3(word), "rs1", rs1(word), "rs2", rs2(word),
                        "funct7", bits(word, 31, 25));
            case "R4": // a third source register takes most of funct7; funct2 picks single or double precision
                return fields("opcode", opcode(word), "rd", rd(word), "funct3", funct3(word), "rs1", rs1(word), "rs2", rs2(word),
                        "funct2", bits(word, 26, 25), "rs3", bits(word, 31, 27));
            case "I":
                if (isShift(word)) return shift(word);
                if (isCsr(word)) return csr(word);
                return fields("opcode", opcode(word), "rd", rd(word), "funct3", funct3(word), "rs1", rs1(word), "imm", word >> 20);
            case "S": // imm[11:5] in bits 31:25, imm[4:0] where rd would be
                return fields("opcode", opcode(word), "funct3", funct3(word), "rs1", rs1(word), "rs2", rs2(word),
                        "imm", (word >> 25) << 5 | bits(word, 11, 7));
            case "B": // a byte offset with bit 0, always 0, not stored: imm[12|10:5] in bits 31:25, imm[4:1|11] in bits 11:7
                return fields("opcode", opcode(word), "funct3", funct3(word), "rs1", rs1(word), "rs2", rs2(word),
                        "imm", (word >> 31) << 12 | bits(word, 7, 7) << 11 | bits(word, 30, 25) << 5 | bits(word, 11, 8) << 1);
            case "U": // the 20-bit upper value as written, not shifted into place
                return fields("opcode", opcode(word), "rd", rd(word), "imm", word >>> 12);
            case "J": // a byte offset with bit 0 not stored: imm[20|10:1|11|19:12] in bits 31:12
                return fields("opcode", opcode(word), "rd", rd(word),
                        "imm", (word >> 31) << 20 | bits(word, 19, 12) << 12 | bits(word, 20, 20) << 11 | bits(word, 30, 21) << 1);
            default:
                throw new IllegalStateException("No fields for format " + format);
        }
    }

    // slli (funct3 001), srli and srai (funct3 101) under the two OP-IMM opcodes.
    private static boolean isShift(int word) {
        return (opcode(word) == 0x13 || opcode(word) == 0x1b) && (funct3(word) == 1 || funct3(word) == 5);
    }

    // The low bits of imm are the shift amount, 6 bits wide for opcode 0x13 on RV64 and 5 otherwise;
    // the bits above it (funct7, or funct6 on RV64) tell srli from srai.
    private static Map<String, Object> shift(int word) {
        int width = opcode(word) == 0x13 && InstructionSet.rv64 ? 6 : 5;
        return fields("opcode", opcode(word), "rd", rd(word), "funct3", funct3(word), "rs1", rs1(word),
                "shamt", bits(word, 19 + width, 20), "funct" + (12 - width), bits(word, 31, 20 + width));
    }

    // csrrw, csrrs and csrrc have funct3 1 to 3 under SYSTEM, and csrrwi, csrrsi and csrrci the same with bit 2
    // set; funct3 0 is ecall, ebreak, uret and wfi.
    private static boolean isCsr(int word) {
        return opcode(word) == 0x73 && (funct3(word) & 3) != 0;
    }

    // The CSR number is unsigned, 0xc00 for cycle. The csr*i forms keep a 5-bit unsigned immediate where rs1 would be.
    private static Map<String, Object> csr(int word) {
        return fields("opcode", opcode(word), "rd", rd(word), "funct3", funct3(word), (funct3(word) & 4) != 0 ? "uimm" : "rs1", rs1(word),
                "csr", bits(word, 31, 20));
    }

    private static int opcode(int word) { return bits(word, 6, 0); }
    private static int rd(int word) { return bits(word, 11, 7); }
    private static int funct3(int word) { return bits(word, 14, 12); }
    private static int rs1(int word) { return bits(word, 19, 15); }
    private static int rs2(int word) { return bits(word, 24, 20); }

    // Bits high down to low of word, as an unsigned number.
    private static int bits(int word, int high, int low) {
        return (word >>> low) & ((1 << (high - low + 1)) - 1);
    }

    private static Map<String, Object> fields(Object... namesAndValues) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (int index = 0; index < namesAndValues.length; index += 2) result.put((String) namesAndValues[index], namesAndValues[index + 1]);
        return result;
    }
}
