vlib work
vmap work work
vcom -2008 -work work rtl/counter.vhd
vcom -2008 rtl/alu.vhd
vcom -2008 tb/counter_tb.vhd
vsim -t 1ns work.counter_tb
add wave -r /*
run -all
quit -f
