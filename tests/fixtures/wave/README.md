`alu.vcd` and `alu.fst` are the waveforms of `tb_alu.vhd` driving `alu.vhd`, and `count.fst` the
waveform of `tb_count.vhd`, written by nvc 1.23 from this folder (delete the `work/` library it
leaves behind):

```sh
nvc -a alu.vhd tb_alu.vhd -e tb_alu -r --wave=alu.vcd --format=vcd
nvc -e tb_alu -r --wave=alu.fst --format=fst
nvc -a tb_count.vhd -e tb_count -r --wave=count.fst --format=fst
```
