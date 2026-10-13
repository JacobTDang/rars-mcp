library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- 1000 cycles of a 10 ns clock driving an 8-bit counter: enough value changes that nvc
-- compresses them.
entity tb_count is
end entity;

architecture sim of tb_count is
  signal clk : std_logic := '0';
  signal count : unsigned(7 downto 0) := (others => '0');
begin
  clock : process
  begin
    for edge in 1 to 2000 loop
      wait for 5 ns;
      clk <= not clk;
    end loop;
    wait;
  end process;

  counter : process (clk)
  begin
    if rising_edge(clk) then
      count <= count + 1;
    end if;
  end process;
end architecture;
