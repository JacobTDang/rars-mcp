library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

entity counter_tb is
end entity counter_tb;

architecture sim of counter_tb is
  signal clk   : std_logic := '0';
  signal reset : std_logic := '1';
  signal count : unsigned(3 downto 0);
begin
  dut : entity work.counter port map (clk => clk, reset => reset, count => count);

  clk <= not clk after 5 ns;

  process
  begin
    wait for 20 ns;
    reset <= '0';
    wait for 100 ns;
    std.env.finish;
  end process;
end architecture sim;
