#!/bin/sh
set -eu
jar_path="${1:-.cache/rars1_6.jar}"
expected="780f730eb457b1ba609e968accc2c8b77d8f92c3d9dbf30cc7fdb3cfb14e8c24"
printf '%s  %s\n' "$expected" "$jar_path" | shasum -a 256 -c -
