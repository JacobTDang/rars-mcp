vlib mylib
vmap mylib mylib
vcom -2008 -work mylib -quiet rtl/counter.vhd
vcom -93 -explicit -work mylib tb/counter_tb.vhd
vsim -L mylib mylib.counter_tb
