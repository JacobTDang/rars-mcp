library ieee;
use ieee.std_logic_1164.all;

entity adder_tb is
end entity adder_tb;

architecture sim of adder_tb is
  signal a, b, sum   : std_logic_vector(3 downto 0) := (others => '0');
  signal carry, zero : std_logic;
begin
  dut : entity work.adder port map (a => a, b => b, sum => sum, carry => carry, zero => zero);

  stimulus : process
  begin
    a <= "0011";
    b <= "0101";
    wait for 10 ns;
    assert sum = "1000" and carry = '0' and zero = '0' report "3 + 5 gave the wrong result" severity error;
    a <= "1000";
    b <= "1000";
    wait for 10 ns;
    assert sum = "0000" and carry = '1' and zero = '1' report "8 + 8 gave the wrong result" severity error;
    report "adder passed";
    wait;
  end process stimulus;
end architecture sim;
