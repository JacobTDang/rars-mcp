# Compiles every VHDL file under src, packages first, then the testbench.
proc vhd_files_under {dir} {
    set found [glob -nocomplain -type f [file join $dir *.vhd]]
    foreach sub [glob -nocomplain -type d [file join $dir *]] {
        set found [concat $found [vhd_files_under $sub]]
    }
    return $found
}

vlib work
vmap work work

set sources [vhd_files_under src]
if {[lsearch $sources */cpu_pkg.vhd] < 0} {
    error "cpu_pkg.vhd not found under src"
}
set compiled {}
foreach file [concat [lsearch -all -inline $sources *_pkg.vhd] $sources] {
    if {[lsearch -exact $compiled $file] >= 0} continue
    vcom -2008 $file
    lappend compiled $file
}
vcom -2008 [file join [pwd] tb cpu_tb.vhd]

vsim work.cpu_tb
run -all
