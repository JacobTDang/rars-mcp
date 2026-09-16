#!/bin/sh
set -eu
out="java/bridge/build/classes"
rm -rf "$out"
mkdir -p "$out"
javac --release 11 -cp .cache/rars1_6.jar -d "$out" $(find java/bridge/src/main/java -name '*.java' -print)
jar --create --file java/bridge/build/rars-mcp-bridge.jar -C "$out" .
