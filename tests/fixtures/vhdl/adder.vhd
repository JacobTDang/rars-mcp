library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;

-- A 4-bit adder with carry and zero flags, the design the vhdl_mutate tests break.
entity adder is
  port (
    a, b  : in  std_logic_vector(3 downto 0);
    sum   : out std_logic_vector(3 downto 0);
    carry : out std_logic;
    zero  : out std_logic
  );
end entity adder;

architecture rtl of adder is
  signal total : unsigned(4 downto 0);
begin
  total <= resize(unsigned(a), 5) + resize(unsigned(b), 5);
  sum   <= std_logic_vector(total(3 downto 0));
  carry <= total(4);
  zero  <= '1' when total(3 downto 0) = 0 else '0';
end architecture rtl;
