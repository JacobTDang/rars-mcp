library ieee;
use ieee.std_logic_1164.all;

-- Checks only the carry of 1 + 0, so it never notices a wrong sum or zero flag.
entity adder_weak_tb is
end entity adder_weak_tb;

architecture sim of adder_weak_tb is
  signal a, b, sum   : std_logic_vector(3 downto 0) := (others => '0');
  signal carry, zero : std_logic;
begin
  dut : entity work.adder port map (a => a, b => b, sum => sum, carry => carry, zero => zero);

  stimulus : process
  begin
    a <= "0001";
    wait for 10 ns;
    assert carry = '0' report "1 + 0 set the carry" severity error;
    report "weak adder check passed";
    wait;
  end process stimulus;
end architecture sim;
