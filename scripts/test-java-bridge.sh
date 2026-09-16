#!/bin/sh
set -eu
out="${TMPDIR:-/tmp}/rars-mcp-java-test"
rm -rf "$out"
mkdir -p "$out"
javac --release 11 -cp .cache/rars1_6.jar -d "$out" \
  $(find java/bridge/src/main/java java/bridge/src/test/java -name '*.java' -print)
java -ea -cp "$out:.cache/rars1_6.jar" dev.rarsmcp.protocol.ProtocolSelfTest
