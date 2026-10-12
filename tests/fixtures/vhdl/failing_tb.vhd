entity failing_tb is
end entity failing_tb;

architecture sim of failing_tb is
  signal count : integer := 0;
begin
  process
  begin
    wait for 20 ns;
    count <= 5;
    wait for 0 ns;
    assert count = 4 report "count is " & integer'image(count) & ", expected 4" severity error;
    report "still running after the failed assertion";
    wait;
  end process;
end architecture sim;
