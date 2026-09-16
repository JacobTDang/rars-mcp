package dev.rarsmcp.protocol;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public final class MiniJson {
    private MiniJson() {}

    public static Object parse(String source) {
        Parser parser = new Parser(source);
        Object value = parser.value();
        parser.space();
        if (!parser.end()) throw new IllegalArgumentException("Trailing JSON data");
        return value;
    }

    public static String stringify(Object value) {
        if (value == null) return "null";
        if (value instanceof String) return quote((String) value);
        if (value instanceof Number || value instanceof Boolean) return value.toString();
        if (value instanceof Map) {
            StringBuilder out = new StringBuilder("{");
            boolean first = true;
            for (Object entryObject : ((Map<?, ?>) value).entrySet()) {
                Map.Entry<?, ?> entry = (Map.Entry<?, ?>) entryObject;
                if (!first) out.append(',');
                first = false;
                out.append(quote(String.valueOf(entry.getKey()))).append(':').append(stringify(entry.getValue()));
            }
            return out.append('}').toString();
        }
        if (value instanceof Iterable) {
            StringBuilder out = new StringBuilder("[");
            boolean first = true;
            for (Object item : (Iterable<?>) value) {
                if (!first) out.append(',');
                first = false;
                out.append(stringify(item));
            }
            return out.append(']').toString();
        }
        throw new IllegalArgumentException("Unsupported JSON value: " + value.getClass());
    }

    private static String quote(String value) {
        StringBuilder out = new StringBuilder("\"");
        for (char c : value.toCharArray()) {
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 32) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.append('"').toString();
    }

    private static final class Parser {
        private final String source;
        private int at;
        Parser(String source) { this.source = source; }
        boolean end() { return at == source.length(); }
        void space() { while (!end() && Character.isWhitespace(source.charAt(at))) at++; }
        char take() { if (end()) throw new IllegalArgumentException("Unexpected end of JSON"); return source.charAt(at++); }
        Object value() {
            space();
            if (end()) throw new IllegalArgumentException("Missing JSON value");
            char c = source.charAt(at);
            if (c == '{') return object();
            if (c == '[') return array();
            if (c == '"') return string();
            if (c == 't') { literal("true"); return true; }
            if (c == 'f') { literal("false"); return false; }
            if (c == 'n') { literal("null"); return null; }
            return number();
        }
        Map<String, Object> object() {
            take();
            Map<String, Object> result = new LinkedHashMap<>();
            space();
            if (!end() && source.charAt(at) == '}') { at++; return result; }
            while (true) {
                space();
                if (source.charAt(at) != '"') throw new IllegalArgumentException("Object key must be a string");
                String key = string();
                space();
                if (take() != ':') throw new IllegalArgumentException("Missing colon");
                result.put(key, value());
                space();
                char separator = take();
                if (separator == '}') return result;
                if (separator != ',') throw new IllegalArgumentException("Missing comma");
            }
        }
        List<Object> array() {
            take();
            List<Object> result = new ArrayList<>();
            space();
            if (!end() && source.charAt(at) == ']') { at++; return result; }
            while (true) {
                result.add(value());
                space();
                char separator = take();
                if (separator == ']') return result;
                if (separator != ',') throw new IllegalArgumentException("Missing comma");
            }
        }
        String string() {
            take();
            StringBuilder result = new StringBuilder();
            while (true) {
                char c = take();
                if (c == '"') return result.toString();
                if (c != '\\') { result.append(c); continue; }
                char escaped = take();
                switch (escaped) {
                    case '"': case '\\': case '/': result.append(escaped); break;
                    case 'b': result.append('\b'); break;
                    case 'f': result.append('\f'); break;
                    case 'n': result.append('\n'); break;
                    case 'r': result.append('\r'); break;
                    case 't': result.append('\t'); break;
                    case 'u': result.append((char) Integer.parseInt(source.substring(at, at += 4), 16)); break;
                    default: throw new IllegalArgumentException("Invalid escape");
                }
            }
        }
        Number number() {
            int start = at;
            while (!end() && "-+0123456789.eE".indexOf(source.charAt(at)) >= 0) at++;
            String token = source.substring(start, at);
            try { return token.contains(".") || token.contains("e") || token.contains("E") ? Double.valueOf(token) : Long.valueOf(token); }
            catch (NumberFormatException error) { throw new IllegalArgumentException("Invalid number"); }
        }
        void literal(String expected) {
            if (!source.startsWith(expected, at)) throw new IllegalArgumentException("Invalid literal");
            at += expected.length();
        }
    }
}
