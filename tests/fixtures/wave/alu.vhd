library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- A 4-bit signed adder that flags two's-complement overflow.
entity alu is
  port (
    a, b : in  std_logic_vector(3 downto 0);
    sum  : out std_logic_vector(3 downto 0);
    ovfl : out std_logic
  );
end entity;

architecture rtl of alu is
  signal s_sum : std_logic_vector(3 downto 0);
begin
  s_sum <= std_logic_vector(signed(a) + signed(b));
  sum <= s_sum;
  ovfl <= (a(3) and b(3) and not s_sum(3)) or (not a(3) and not b(3) and s_sum(3));
end architecture;
