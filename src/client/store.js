/**
 * Module-level UI store for the SSH ops panel: open state, connection list,
 * active connection/session, connection form state, and error status. The
 * header action and the panel share it via useSyncExternalStore.
 */
import { useSyncExternalStore } from "react";

function initialOpen() {
  // The terminal is a temporary work surface, not a saved workspace pane.
  // Always start closed so opening DSH never steals conversation space.
  try {
    // Clear the key written by earlier releases so they do not reopen the
    // drawer after this upgrade.
    localStorage.removeItem("dsh-ssh-ops.open");
  } catch {
  }
  return false;
}

let snapshot = {
  open: initialOpen(),
  connections: [],
  activeConnectionId: null,
  activeSessionId: null,
  busy: false,
  error: null
};

const listeners = new Set();

function set(patch) {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

export function getSshUiSnapshot() {
  return snapshot;
}

export function subscribeSshUi(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSshUi() {
  return useSyncExternalStore(subscribeSshUi, getSshUiSnapshot);
}

export function sshUiSetOpen(open) {
  set({ open });
}

export function sshUiSetConnections(connections) {
  set({ connections });
}

export function sshUiSetActive(connectionId, sessionId) {
  set({ activeConnectionId: connectionId, activeSessionId: sessionId });
}

export function sshUiSetBusy(busy) {
  set({ busy });
}

export function sshUiSetError(error) {
  set({ error });
}
