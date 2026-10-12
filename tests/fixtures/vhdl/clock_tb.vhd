entity clock_tb is
  generic (period : time := 10 ns);
end entity clock_tb;

architecture sim of clock_tb is
  signal clk   : bit := '0';
  signal edges : natural := 0;
begin
  -- The clock never stops, so only a stop time or the wall-clock limit ends the run.
  clk <= not clk after period / 2;

  process (clk)
  begin
    if clk'event and clk = '1' then
      edges <= edges + 1;
    end if;
  end process;

  process
  begin
    wait for 100 ns;
    report "rising edges in 100 ns: " & integer'image(edges);
    wait;
  end process;
end architecture sim;
