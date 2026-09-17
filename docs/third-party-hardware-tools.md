# Hardware worker third-party inventory

The worker image installs these pinned application packages in addition to Debian Bookworm packages recorded in the image SBOM:

- RARS 1.6 (core image, BSD-3-Clause)
- pywellen 0.25.6 / wellen (BSD-3-Clause)
- cocotb 2.0.0 (BSD-3-Clause)
- pytest 8.4.2 (MIT)
- SymbiYosys 0.68 (ISC)
- Verilator, GHDL, Yosys, and Boolector from the pinned Debian Bookworm base repositories

Run `docker sbom rars-mcp-hardware-worker` (or an equivalent OCI SBOM tool) against a built image for the exact transitive OS-package inventory.
