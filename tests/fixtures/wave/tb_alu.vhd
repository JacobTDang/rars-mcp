library ieee;
use ieee.std_logic_1164.all;

entity tb_alu is
end entity;

architecture sim of tb_alu is
  type phase_t is (SETUP, CHECK, DONE);
  signal s_a, s_b, s_sum : std_logic_vector(3 downto 0);
  signal s_ovfl : std_logic;
  signal s_late : std_logic;  -- 'U' until 20 ns
  signal s_ratio : real := 0.0;
  signal s_step : integer := 0;
  signal s_phase : phase_t := SETUP;
begin
  dut : entity work.alu port map (a => s_a, b => s_b, sum => s_sum, ovfl => s_ovfl);

  stimulus : process
  begin
    s_a <= "0011"; s_b <= "0010"; s_ratio <= 1.5;   -- 3 + 2 = 5
    wait for 10 ns;
    s_a <= "0111"; s_b <= "0001"; s_ratio <= 0.25;  -- 7 + 1 overflows to -8
    s_step <= 1; s_phase <= CHECK;
    wait for 10 ns;
    s_a <= "1000"; s_b <= "1111"; s_ratio <= -2.0;  -- -8 + -1 overflows to 7
    s_step <= 2; s_late <= '1';
    wait for 10 ns;
    s_a <= "01ZX"; s_b <= "0001";                   -- unknown inputs
    s_step <= -1; s_phase <= DONE;
    wait for 10 ns;
    wait;
  end process;
end architecture;
