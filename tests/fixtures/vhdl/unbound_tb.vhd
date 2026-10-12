entity unbound_tb is
end entity unbound_tb;

architecture sim of unbound_tb is
  component adder_core is
    port (x : in bit; y : out bit);
  end component adder_core;
  signal x, y : bit := '0';
begin
  dut : adder_core port map (x => x, y => y);

  process
  begin
    x <= '1';
    wait for 10 ns;
    report "unbound testbench finished";
    wait;
  end process;
end architecture sim;
