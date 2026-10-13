# Commands from the Questa SIM tutorial scripts, from compile to batch run.
onbreak {resume}
transcript on
if {[file exists work]} { vdel -lib work -all }
vlib work
vmap work work
vcom -2008 rtl/counter.vhd tb/counter_tb.vhd
vsim -voptargs=+acc work.counter_tb
do wave.do
log -r /*
nolog /counter_tb/clk
property wave -radix unsigned /counter_tb/count
vcd file counter.vcd
vcd add -r /counter_tb/*
when -label reached {/counter_tb/count = "1000"} {
  echo "count reached 8 at $now"
  stop
}
bp rtl/counter.vhd 20
force -freeze /counter_tb/reset 1 0
run 20 ns
echo "count is [examine -radix unsigned /counter_tb/count]"
bookmark add wave reset {{0 ns} {40 ns}} 0
step
bd rtl/counter.vhd 20
nowhen reached
noforce /counter_tb/reset
run -all
wave zoom full
write format wave saved_wave.do
coverage report
simstats
quit -f
