package dev.rarsmcp.gui;

import dev.rarsmcp.server.BridgeServer;
import rars.Globals;
import rars.Launch;

public final class DesktopBridgeMain {
    public static void main(String[] args) throws Exception {
        String token = argument(args, "--token");
        int port = Integer.parseInt(argument(args, "--port"));
        Thread gui = new Thread(() -> Launch.main(new String[] { "g" }), "rars-gui-launcher");
        gui.start();
        long deadline = System.currentTimeMillis() + 15_000;
        while (Globals.getGui() == null && System.currentTimeMillis() < deadline) Thread.sleep(50);
        if (Globals.getGui() == null) throw new IllegalStateException("RARS GUI startup timed out");
        BridgeServer.run(token, port, "live", new GuiBridgeHooks());
    }

    private static String argument(String[] args, String name) {
        for (int i = 0; i + 1 < args.length; i++) if (args[i].equals(name)) return args[i + 1];
        throw new IllegalArgumentException("Missing argument " + name);
    }
}
