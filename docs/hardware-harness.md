# Hardware harness

The optional RTL worker runs VHDL and Verilog/SystemVerilog projects without blocking RARS. Start it with `docker compose --profile rtl up -d --build` and stop it with `docker compose --profile rtl down`.

Put `hardware.project.yaml` and project sources under `workspace/`. Paths and globs are relative to that workspace. A minimal SystemVerilog lint target is:

```yaml
version: 1
name: example
sources: ["rtl/**/*.sv"]
targets:
  lint:
    provider: verilator
    language: systemverilog
    standard: "1800-2017"
    top: top
    action: lint
```

Call `hardware_project_validate` first. Start work with `hardware_job_start`, poll `hardware_job_status`, and inspect bounded logs and artifact metadata after completion. Job state is stored in the `hardware-state` Docker volume. A worker restart marks interrupted jobs `aborted`; it never resumes processes silently.

Waveform artifacts (`.vcd`, `.fst`, and `.ghw`) are indexed lazily with `hardware_wave_query`; the tool returns bounded hierarchy, signal, value, transition, edge, unknown, pulse-width, and comparison results. Retirement traces use JSON Lines and can be normalized from `rars`, `rvfi`, or `normalized` records with `hardware_trace_compare`. `hardware_riscv_generate` creates repeatable assembly tests from a seed.

The worker image includes cocotb, Yosys, SymbiYosys, and Boolector. Targets use providers `cocotb`, `yosys`, or `sby`; set `top` to the workspace-relative pytest file, Yosys script, or `.sby` file. `riscv-formal` and `spike` are capability-gated and report unavailable unless their external assets or executable are installed.

Repository commands require `allow_repository_command: true` in the target and `HARDWARE_ALLOW_REPOSITORY_COMMANDS=true` on the worker. They are disabled in the supplied Compose configuration.
