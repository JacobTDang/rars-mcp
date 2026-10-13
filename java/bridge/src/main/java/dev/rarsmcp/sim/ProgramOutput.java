package dev.rarsmcp.sim;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CoderResult;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

// One run's stdout and stderr. Together they keep at most limit bytes, as rars_run does; later output
// is dropped and truncated is set. Each take hands over only what was written after the previous one.
final class ProgramOutput {
    private final long limit;
    private final Stream stdout = new Stream();
    private final Stream stderr = new Stream();
    private long kept;
    private boolean truncated;

    ProgramOutput(long limit) {
        this.limit = limit;
    }

    // The streams RARS writes the program's stdout and stderr to.
    ByteArrayOutputStream stdout() { return stdout; }
    ByteArrayOutputStream stderr() { return stderr; }

    // The new text of each stream, the bytes of each handed over so far in this run, and whether output
    // was dropped. ended: the run can write nothing more, so a character still missing bytes is not held back.
    synchronized Map<String, Object> take(boolean ended) {
        boolean finished = ended || kept == limit;
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("stdout", stdout.take(finished));
        result.put("stderr", stderr.take(finished));
        result.put("stdoutBytes", stdout.taken);
        result.put("stderrBytes", stderr.taken);
        result.put("truncated", truncated);
        return result;
    }

    // RARS writes a printed string through a writer, and a write ecall one byte at a time.
    private final class Stream extends ByteArrayOutputStream {
        private final CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPLACE).onUnmappableCharacter(CodingErrorAction.REPLACE);
        private long taken;

        @Override
        public void write(int value) {
            write(new byte[] { (byte) value }, 0, 1);
        }

        @Override
        public void write(byte[] bytes, int offset, int length) {
            synchronized (ProgramOutput.this) {
                int room = (int) Math.min(length, limit - kept);
                super.write(bytes, offset, room);
                kept += room;
                if (room < length) truncated = true;
            }
        }

        // The bytes kept since the last take, as UTF-8 text. A character whose last bytes are not written
        // yet waits for them, unless finished says they cannot come.
        private String take(boolean finished) {
            ByteBuffer bytes = ByteBuffer.wrap(buf, 0, count);
            // UTF-8 never gives more characters than bytes, replacements included.
            CharBuffer text = CharBuffer.allocate(count);
            CoderResult result = decoder.decode(bytes, text, finished);
            if (finished && result.isUnderflow()) result = decoder.flush(text);
            if (!result.isUnderflow()) throw new IllegalStateException("Program output did not decode: " + result);
            if (finished) decoder.reset();
            int used = bytes.position();
            System.arraycopy(buf, used, buf, 0, count - used);
            count -= used;
            taken += used;
            return text.flip().toString();
        }
    }
}
