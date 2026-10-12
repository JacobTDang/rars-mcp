`alu.vcd` and `alu.fst` are the waveforms of `tb_alu.vhd` driving `alu.vhd`, written by nvc 1.23
from this folder (delete the `work/` library it leaves behind):

```sh
nvc -a alu.vhd tb_alu.vhd -e tb_alu -r --wave=alu.vcd --format=vcd
nvc -e tb_alu -r --wave=alu.fst --format=fst
```
