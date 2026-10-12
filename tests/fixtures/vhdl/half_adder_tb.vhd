library ieee;
use ieee.std_logic_1164.all;

entity half_adder_tb is
end entity half_adder_tb;

architecture sim of half_adder_tb is
  signal a, b, sum, carry : std_logic := '0';
begin
  dut : entity work.half_adder port map (a => a, b => b, sum => sum, carry => carry);

  stimulus : process
  begin
    a <= '1';
    b <= '1';
    wait for 10 ns;
    assert sum = '0' and carry = '1' report "1 + 1 gave the wrong sum or carry" severity error;
    report "half adder passed";
    wait;
  end process stimulus;
end architecture sim;
