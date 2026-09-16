#!/bin/zsh
set -eu
project_dir="${0:A:h:h}"
runtime_dir="$project_dir/.runtime"
mkdir -p "$runtime_dir"
chmod 700 "$runtime_dir"
token_file="$runtime_dir/token"
port_file="$runtime_dir/port"
openssl rand -hex 32 > "$token_file"
chmod 600 "$token_file"
cd "$project_dir"
if [[ ! -f .cache/rars1_6.jar ]]; then
  mkdir -p .cache
  curl -fsSL https://github.com/TheThirdOne/rars/releases/download/v1.6/rars1_6.jar -o .cache/rars1_6.jar
fi
scripts/verify-rars.sh .cache/rars1_6.jar
scripts/build-java-bridge.sh
token="$(<"$token_file")"
rm -f "$port_file"
java -cp "java/bridge/build/rars-mcp-bridge.jar:.cache/rars1_6.jar" \
  dev.rarsmcp.gui.DesktopBridgeMain --token "$token" --port 0 \
  2> >(
    while IFS= read -r line; do
      if [[ "$line" == RARS_MCP_PORT=* ]]; then
        print -r -- "${line#RARS_MCP_PORT=}" > "$port_file"
        chmod 600 "$port_file"
      else
        print -r -- "$line" >&2
      fi
    done
  )
