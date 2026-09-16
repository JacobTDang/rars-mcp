package dev.rarsmcp.gui;

import dev.rarsmcp.server.BridgeHooks;
import rars.Globals;
import rars.venus.EditPane;
import rars.venus.EditTabbedPane;
import rars.venus.ExecutePane;
import rars.venus.VenusUI;

import javax.swing.SwingUtilities;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

public final class GuiBridgeHooks implements BridgeHooks {
    public void beforeLoad(List<String> files, Map<String, Object> payload) throws Exception {
        onSwing(() -> {
            VenusUI gui = requireGui();
            EditTabbedPane tabs = (EditTabbedPane) gui.getMainPane().getEditTabbedPane();
            String policy = String.valueOf(payload.getOrDefault("conflictPolicy", "reject"));
            for (String path : files) {
                EditPane pane = tabs.getEditPaneForFile(path);
                if (pane != null && pane.hasUnsavedEdits() && !policy.equals("discard")) {
                    throw new IllegalStateException("UNSAVED_CHANGES: " + path);
                }
            }
            gui.getEditor().open(new ArrayList<>(files));
        });
    }

    public void afterMutation() throws Exception {
        onSwing(() -> {
            VenusUI gui = requireGui();
            ExecutePane execute = gui.getMainPane().getExecutePane();
            execute.getTextSegmentWindow().setupTable();
            execute.getTextSegmentWindow().highlightStepAtPC();
            execute.getDataSegmentWindow().setupTable();
            execute.getDataSegmentWindow().updateValues();
            execute.getRegistersWindow().refresh();
            execute.getFloatingPointWindow().refresh();
            execute.getControlAndStatusWindow().refresh();
            gui.getMainPane().setSelectedComponent(execute);
        });
    }

    private static VenusUI requireGui() {
        VenusUI gui = Globals.getGui();
        if (gui == null) throw new IllegalStateException("RARS GUI is not ready");
        return gui;
    }

    private static void onSwing(ThrowingRunnable action) throws Exception {
        if (SwingUtilities.isEventDispatchThread()) { action.run(); return; }
        AtomicReference<Exception> failure = new AtomicReference<>();
        SwingUtilities.invokeAndWait(() -> { try { action.run(); } catch (Exception error) { failure.set(error); } });
        if (failure.get() != null) throw failure.get();
    }

    private interface ThrowingRunnable { void run() throws Exception; }
}
