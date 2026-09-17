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

Repository commands require `allow_repository_command: true` in the target and `HARDWARE_ALLOW_REPOSITORY_COMMANDS=true` on the worker. They are disabled in the supplied Compose configuration.
