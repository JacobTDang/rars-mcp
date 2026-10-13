# RARS MCP

RARS MCP gives Claude Code, Codex, Antigravity and other MCP clients access to the
[RARS](https://github.com/TheThirdOne/rars) RISC-V assembler and simulator: assemble and run
programs, step through them in a real debugger, read registers and memory, list symbols and
assembled instructions, write memory images for hardware simulation, and drive a visible RARS
desktop session. It also compiles and runs VHDL testbenches with
[nvc](https://www.nickg.me.uk/nvc/).

![rars-mcp demo](docs/media/rars-mcp.gif)

<sub>Assemble, run, break on a label, dump a memory image — 20 seconds, no sound.
[Watch the MP4](docs/media/rars-mcp.mp4) for full resolution and the soundtrack.</sub>

## Quick start

Requirements: Node.js 22 and a JDK 11 or later.

```sh
npm ci
npm run build
mkdir -p .cache
curl -fsSL https://github.com/TheThirdOne/rars/releases/download/v1.6/rars1_6.jar -o .cache/rars1_6.jar
scripts/verify-rars.sh
scripts/build-java-bridge.sh
```

Register it with Claude Code. The stdio entry point runs the server in its own process, so
nothing else has to be running:

```sh
claude mcp add --scope user rars -- node /path/to/rars-mcp/dist/src/stdio.js
```

Start your client in the folder holding your `.s` files and the server works there. Examples for
other clients are in `examples/clients/`.

## Which files the server can read

Every path is checked against the workspace folders, after resolving symlinks, and anything
outside them is refused. An output file that does not exist yet, such as a `dump` or wave `file`,
must be in an existing folder, and a symlink whose target does not exist is refused as an output
path, because writing through it would create its target. Folders come from, in order:

- **The client's roots.** A client that advertises the MCP `roots` capability has its roots used
  as workspace folders, so the workspace follows the client's project with no configuration.
  A root that does not exist or names a folder on another host is skipped, and `rars_status` lists
  it with the reason. If the client fails to answer `roots/list`, the call that asked reports the
  error and the next call asks again.
- **`RARS_WORKSPACE`.** One or more folders separated by `:` (`;` on Windows). Relative paths
  resolve against the first one.
- **The starting folder.** Without `RARS_WORKSPACE`, the stdio entry point uses the folder the
  client started it in.

## Tools

- **`rars_status`** — check the setup without writing a program: RARS and Java versions, the bridge
  JAR, workspace folders, client roots and any skipped client roots with the reason, open sessions,
  and the `tclsh` used by `do_file_check` and the VHDL simulator. For `tclsh` and the simulator it
  gives the executable, where it was found on `PATH`, its version, and the variable that selects it
  (`TCLSH`, `VHDL_SIMULATOR`). Each missing piece is reported in its own field.

### Running programs

- **`rars_assemble`** — assemble source files and return structured diagnostics.
- **`rars_run`** — run them. Options: `stdin`, `programArgs`, `registers`, `memoryRanges`,
  `instructionCount`, `maxSteps`, `timeoutMs`. `registers` takes `x0`-`x31`, `zero`, `ra`, `sp`,
  `gp`, `tp`, `fp`, `t0`-`t6`, `s0`-`s11`, `a0`-`a7`, `f0`-`f31`, `ft0`-`ft11`, `fs0`-`fs11`,
  `fa0`-`fa7`, and the CSRs `ustatus`, `fflags`, `frm`, `fcsr`, `uie`, `utvec`, `uscratch`, `uepc`,
  `ucause`, `utval`, `uip`, `cycle`, `time`, `instret`, `cycleh`, `timeh` and `instreth`. The RARS
  command line cannot print `pc`; read it with `rars_inspect`. `memoryRanges` takes word-aligned
  ranges such as `0x10010000-0x1001000c`, both ends included. Requested registers and memory come
  back as structured values, not raw RARS text:

  ```json
  { "registers": { "t0": { "hex": "0xfffff000", "signed": -4096 } },
    "memory": [{ "address": "0x10010000", "hex": "0x6c6c6568", "signed": 1819043176 }],
    "instructionCount": 22 }
  ```

  `instructionCount` is RARS's `ic` count, which excludes the final exit `ecall`: `li t0, 3`,
  `li a7, 10`, `ecall` reports `2`.
- **`rars_eval`** — expected results for up to 1024 RV32I/M ALU cases, such as
  `{ "op": "slt", "rs1": "0xFFFFFFFB", "rs2": "0x7FFFFFFF" }`, with `imm` in place of `rs2` for
  `addi`, `slti`, `sltiu`, `xori`, `ori`, `andi`, `slli`, `srli`, `srai`. The cases run in one generated
  program, and each comes back with `rd` as `hex`, `signed` and `unsigned` plus a `zero` flag.
  `format: "vhdl"` also returns a constant table to paste into a testbench. It reads the results
  through a label dump, so it requires the bridge.

`rars_assemble`, `rars_run`, and `rars_debug_start` accept `source` instead of `files` for
throwaway programs. Pass a string for one `inline.s` file, or an array such as
`[{ "name": "main.s", "text": "..." }, { "name": "lib.s", "text": "..." }]` for several files.

Both accept `dump`, which uses RARS's memory-image dumper. Omit `file` to return text formats as
`text` (`HexText` also returns normalized `words`) or binary formats as `bytesBase64`; include a
workspace-relative `file` to write the image there as before:

```json
"dump": [{ "segment": ".text", "format": "HexText", "file": "mem/imem.hex" }]
```

`segment` is `.text`, `.data`, a range like `0x400000-0x10000000`, or an exact-length object such
as `{ "address": "0x10010000", "words": 180 }`. `{ "label": "results", "words": 180 }` resolves
the start through the headless bridge's symbol table, so label dumps require the bridge to be
configured. Range bounds, `address`, and a label's address must be multiples of 4, and a range
cannot end past `0xffffffff`; RARS refuses either dump. `words` is at most 65536. `format` is one
of `SegmentWindow`, `HexText`, `AsciiText`, `HEX`, `Binary`, `BinaryText`. With `rars_assemble`
the image is produced without running the program. For file-backed dumps, the target folder must
already exist. When RARS writes no file for a dump, the reply is an error that keeps the run's
results and quotes RARS's reason.

### Encoding instructions

- **`rars_encode`** — encode up to 200 instructions with RARS's own assembler. Each comes back
  with its basic form and one word per basic instruction (a pseudo-instruction such as `li` may
  give two). A word has its hex, its format (`R`, `R4`, `I`, `S`, `B`, `U` or `J`) and its fields as
  numbers:

  ```json
  { "source": "sw t2, -4(sp)", "basic": ["sw x7,0xfffffffc(x2)"],
    "words": [{ "hex": "0xfe712e23", "format": "S",
                "fields": { "opcode": 35, "funct3": 2, "rs1": 2, "rs2": 7, "imm": -4 } }] }
  ```

  - `imm` is signed and already put back together for `S`, `B` and `J`; for `U` it is the 20-bit
    upper value. Shift-immediates are `I` with `shamt` and `funct7`; `fmadd` and the other fused
    multiply-adds are `R4` with `rs3` and `funct2`.
  - CSR instructions, and pseudo-instructions such as `csrr` and `rdcycle`, are `I` with `csr` in
    place of `imm`: the CSR number, unsigned, so `rdcycle t0` gives `"csr": 3072` (0xc00).
    `csrrwi`, `csrrsi` and `csrrci` have `uimm`, their 5-bit unsigned immediate, in place of `rs1`.
  - A branch or jump target may be a number, read as a byte offset from the instruction:
    `beq x1, x2, -8`. RARS itself takes only a label there, so the tool puts a label at that offset.
  - The instructions are assembled one after another as one program, so one can branch to a label
    on another.
  - An instruction RARS rejects comes back as `{ source, error }` with RARS's message. The call
    fails only when no instruction encodes.

### Debugging

- **`rars_debug_start`** — start an isolated debugger session on one or more files.
- **`rars_debug_command`** — `step`, `backstep`, `continue`, `pause`, `reset`, `terminate`,
  `breakpoint_add`, `breakpoint_remove`.
  - A breakpoint `address` may be a number, a code label such as `EXIT`, or a source location
    such as `prob1a.s:17`.
  - `continue` takes an optional `maxSteps` (1,000,000 by default).
  - Every step and continue reports why it stopped: `step`, `breakpoint`, `step_limit`, `exited`,
    `ran_off_end`, `exception` or `terminated`. A program that has terminated refuses to run
    until the session is reset.
- **`rars_inspect`** — registers (including `pc`) and bounded memory as `{ hex, signed }`, plus
  `includeSymbols` for the symbol table and `instructions` for a window of the assembled program
  with each instruction's address, machine code, basic form, source line and file.
  - `signed` is a number, except for memory read with `length: 8`, where it is a decimal string
    such as `"-9223372036854775808"`: a JSON number cannot hold every 64-bit value exactly.
  - `instructions: { around, count }` returns `count` instructions (10 by default, at most 200)
    centred on `around`: `pc` (the default), a code label, an address, or `file:line`. With an
    even `count` the extra instruction comes after. `instructions: {}` is the 10 around `pc`.
  - `instructions: { from, to }` returns every instruction from one location to the other,
    inclusive, and refuses a range of more than 200.
  - An unknown label, or an address with no instruction, is an error. The exception is `pc` with
    no instruction, as after the program exits: the window then ends at the last instruction below
    `pc`, so `instructions: {}` shows the program's last 10.
  - `includeInstructions: true` still returns the whole program, but is deprecated.
- **`rars_modify`** — write registers or memory. Values are decimal or `0x` hex strings, signed or
  unsigned, and must fit the register or the `width`; a `width: 8` value is exact across all 64
  bits, from `"-9223372036854775808"` to `"0xffffffffffffffff"`. Every register name, address,
  alignment and value is checked before anything is written, so a rejected request changes
  nothing. An 8-byte write must start on a word boundary, as an 8-byte read must.
- **`rars_session_list`**, **`rars_session_close`** — a session with no requests for
  `RARS_SESSION_IDLE_MS` closes itself and then reports `SESSION_EXPIRED`.

### The visible desktop session

- **`rars_live_connect`**, **`rars_live_command`** — drive the RARS application you can see.

### VHDL

`vhdl_compile`, `vhdl_run` and `vhdl_mutate` run nvc, which is included in the Docker image.
For a local installation, install it separately (`brew install nvc` on macOS); set
`VHDL_SIMULATOR` if it is not on `PATH`. They build the design library in a temporary folder
that is removed after each call, so only a requested wave file is written to the workspace.
They share the wall-clock and output limits of a RARS run.

- **`vhdl_compile`** — analyse VHDL files in the given order and return diagnostics with file, line
  and column. Options: `std` (`93`, `02`, `08` or `19`; `08` by default, `02` matches Questa's
  default) and `work`, the library name (`work` by default).
- **`vhdl_run`** — analyse the files, elaborate `testbench` and run it. Options: `std`, `work`,
  `stopTime` (such as `"1 us"`), `generics` (such as `{ "WIDTH": "8" }`) and `wave`. Every `report`
  and assertion comes back with its simulation time and source location:

  ```json
  { "ok": false, "exitCode": 1,
    "messages": [{ "time": "20ns", "severity": "error", "text": "count is 5, expected 4",
                   "source": { "file": "/project/failing_tb.vhd", "line": 12, "column": 12 } }] }
  ```

  - An assertion of severity `error` or `failure` stops the run and sets `ok` to `false`. A runtime
    error found by the simulator, such as an index out of range, has severity `fatal`.
  - A component with no matching entity is left unbound and its instances do nothing, so the
    testbench can pass without testing anything. `vhdl_run` reports each one as a `warning`
    diagnostic.
  - Without `stopTime` the run lasts until no events remain, or until the wall-clock limit.
  - `wave: { "file": "waves/tb.vcd" }` writes a waveform of the run. `format` is `vcd`, or `fst`,
    the default for a file ending in `.fst`; `wave_query` reads both. The target folder must
    already exist.
- **`vhdl_mutate`** — check that testbenches catch real bugs. Each mutation is applied to a copy
  of `file` in a temporary folder, and each of `testbenches` (`{ "top", "files" }`, where `files`
  must include `file`) runs with the copy in its place. A testbench catches the mutation when it
  fails. `mutations` are literal substitutions, `{ "find", "replace" }` with an optional `name`
  and `occurrence` (counted from 1; every match by default), and a `find` that matches nothing is
  an error. Without them, each operator in the file's statements becomes one mutation, up to 64:
  `+`/`-`, `and`/`or`, `=`/`/=`, `<`/`>=`, `<=`/`>`, `'0'`/`'1'` in assignments, and removing
  `not`. Options: `std`, `stopTime` and `timeoutMs`, the limit for each run.

  ```json
  { "mutations": [{ "name": "line 18: + -> -", "line": 18, "caught": true,
                    "caughtBy": ["adder_tb"], "missedBy": ["adder_weak_tb"] }],
    "score": { "caught": 1, "total": 1, "ratio": 1 } }
  ```

  The unmutated design runs first. If a testbench fails on it, no mutation runs and the result is
  an error, as it is for a mutated copy that does not analyse. A low score is not an error.
- **`wave_query`** — read signal values from a VCD or FST waveform at chosen times, so a check
  like "is `s_ovfl` 1 at 20 ns?" needs no waveform viewer. Signals are hierarchical names such as
  `tb_alu.s_ovfl` or `tb_alu/dut/s_sum`, matched ignoring case. Times look like `20 ns`, `1.5us`,
  or a bare `100` in the file's timescale units. Each value is the last change at or before that
  time, and a time before the first dump reads as `x`:

  ```json
  { "time": "20 ns", "tb_alu.s_sum": { "bits": "0111", "hex": "0x7", "unsigned": 7, "signed": 7 },
    "tb_alu.s_ratio": { "real": -2 }, "tb_alu.s_phase": { "string": "check" } }
  ```

  `hex`, `unsigned` and `signed` are `null` when a bit is not 0 or 1. An unknown signal is an error
  that lists the signals sharing its last name. nvc writes VCD with `--wave=tb.vcd --format=vcd`
  and FST with `--wave=tb.fst --format=fst`; GHDL writes VCD with `--vcd=tb.vcd`. An FST file
  gives the same result as a VCD file of the same run. It is read whole, so it is refused when it,
  or any part of it, unpacks to more than `WAVE_MAX_BYTES`. FST features that nvc does not write,
  such as LZ4 or FastLZ compression and `$dumpoff` periods, are refused with an error that names
  them. GHW files, gzip-compressed VCD files and files over `WAVE_MAX_BYTES` are refused.

  The result also gives the dump's first and last timestamps as `startTime` and `endTime`, such as
  `"40 ns"`. An FST file gives them in its header. A VCD file is read to the end to find them,
  and a VCD file with no timestamp is an error. A row for a time before the first timestamp or
  after the last one still has the values the file implies, but those values were not recorded,
  so the row also has `"beyond": "before"` or `"after"` and the table ends it with
  `(before start 5 ns)` or `(after end 40 ns)`. When no time is inside the dump, the table starts
  with a line that says so, such as `The dump ends at 40 ns, before every requested time.`

- **`do_file_check`** — dry-run a Questa or ModelSim `.do` script without a simulator. Returns
  the files it compiles, in order, with each one's library, VHDL standard and whether it exists,
  plus the `vlib` libraries, the `vsim` top and any Tcl error with its file and line. `std` sets
  the standard for `vcom` calls that name none.

`do_file_check` runs the script with `tclsh` 8.5 or later, included in the Docker image.
For local installations, set `TCLSH` if it is not on `PATH`.
`vlib`, `vmap`, `vcom`, `vlog`, `vsim`, `run`, `add wave` and the other common Questa
commands are stubs that record their calls. The script has no shell or file access: nested `do`
files, `file exists`, `glob` and `pwd` are answered from the workspace. Relative paths resolve from
the script's folder, as if Questa ran it there, and `pwd` returns that folder. `glob` takes
`-nocomplain`, `-types f` or `d`, `-directory`, `-tails` and several patterns, returns matches
sorted and in the form the pattern was written, and fails when a pattern leads outside the
workspace.

## Run in Docker

Requirements: Docker Desktop with Compose.

The image includes nvc 1.23.0 and Tcl 8.6 (`tclsh`) alongside Node.js, Java and RARS, so the
VHDL tools and `.do` script checks work without host installations. nvc is built from a
SHA-256-verified release tarball in a separate stage; build tools stay out of the runtime image.
Both executables are on `PATH`, and the server runs as the unprivileged `node` user.

```sh
mkdir -p workspace
docker compose up -d --build
curl http://127.0.0.1:3000/health
```

Put `.s`, `.vhd` and `.do` files in `workspace/`. HTTP-capable clients connect to
`http://127.0.0.1:3000/mcp`. Stdio-only clients use the proxy, which forwards to that server:

```sh
docker exec -i rars-mcp node dist/src/stdio-proxy.js
```

View logs with `docker compose logs -f`, stop with `docker compose down`, and rebuild after an
update with `docker compose build --no-cache && docker compose up -d`.

Run `scripts/test-docker-image.sh` to build and smoke-test the image. It checks nvc and Tcl,
then calls the VHDL tools and `do_file_check` through the stdio server using the adder fixtures.
Any build, executable or tool failure exits non-zero. An optional first argument sets the image
tag (default: `rars-mcp:smoke`).

## Desktop session

```sh
./scripts/launch-rars-mcp.command
```

The launcher opens RARS and writes protected discovery files into the ignored `.runtime/`
directory. Call `rars_live_connect`, then use its session ID with `rars_live_command`. See
`docs/live-session.md` for the commands and how unsaved buffers are handled.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `RARS_WORKSPACE` | the starting folder (stdio) | Folders the server may read, separated by `:` |
| `RARS_JAR` | `.cache/rars1_6.jar` | The RARS JAR |
| `RARS_BRIDGE_JAR` | `java/bridge/build/rars-mcp-bridge.jar` | The Java bridge used by debugger sessions |
| `RARS_BRIDGE_HOST` | `127.0.0.1` | Host of the visible desktop session |
| `RARS_LIVE_DISCOVERY_DIR` | `.runtime` | Where the launcher writes its port and token |
| `RARS_EXECUTION_TIMEOUT_MS` | `10000` | Wall-clock limit for one run, and for starting the Java bridge |
| `RARS_MAX_OUTPUT_BYTES` | `1048576` | Output captured per run |
| `RARS_MAX_INSPECTION_BYTES` | `65536` | Limit on one inspection |
| `RARS_SESSION_IDLE_MS` | `1800000` | Idle time before a debugger session closes |
| `WAVE_MAX_BYTES` | `67108864` | Largest waveform file `wave_query` reads, and the most an FST file or any part of it may unpack to |
| `JAVA_EXECUTABLE` | `java` | Java binary to run |
| `TCLSH` | `tclsh` | Tcl shell `do_file_check` runs scripts with |
| `VHDL_SIMULATOR` | `nvc` | nvc executable used by the VHDL tools |
| `PORT` | `3000` | HTTP entry point port |
| `RARS_MCP_URL` | `http://127.0.0.1:3000/mcp` | Server the stdio proxy forwards to |

Paths default to this checkout and are resolved from the package, not the current directory, so
the server works no matter where it is started. The Docker image sets them explicitly.

## Development

```sh
npm run lint                                   # tsc --noEmit
RARS_JAR="$PWD/.cache/rars1_6.jar" npm run test:run   # vitest once; RARS-backed tests need the JAR
scripts/test-java-bridge.sh                    # Java bridge self-tests
npm run build
```

The VHDL tests run only when `nvc`, or the executable in `VHDL_SIMULATOR`, is available.

`npm run start:stdio` runs the stdio entry point, `npm run start:http` the HTTP server, and
`npm run start:proxy` the proxy used inside Docker.

See `docs/security.md` before changing network bindings or workspace folders,
`docs/troubleshooting.md` for recovery steps, and `docs/bug-log.md` for fixed defects and how
they were found.
