vlib work
vcom -2008 rtl/counter.vhd
if {1} {
  vcom -2008 tb/counter_tb.vhd

vsim counter_tb
