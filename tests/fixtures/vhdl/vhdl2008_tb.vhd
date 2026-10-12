entity vhdl2008_tb is
end entity vhdl2008_tb;

architecture sim of vhdl2008_tb is
  signal a, b, y : bit := '0';
begin
  process (all)
  begin
    y <= a and b;
  end process;

  process
  begin
    a <= '1';
    b <= '1';
    wait for 1 ns;
    report "y is " & to_string(y);
    wait;
  end process;
end architecture sim;
