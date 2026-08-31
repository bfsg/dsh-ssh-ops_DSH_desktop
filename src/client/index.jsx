/**
 * dsh-ssh-ops browser plugin entry: mounts the sshOps Remote contribution,
 * then registers the header action (open/close the SSH panel) and the
 * right-side floating panel itself.
 */
import * as React from "react";
import { createSshApi } from "./api.js";
import { SshPanel } from "./SshPanel.jsx";
import { SshResources } from "./SshResources.jsx";
import { getSshUiSnapshot, sshUiSetOpen, useSshUi } from "./store.js";
import TYPERT_REMOTE from "../remote.js";

const NS = "ssh-ops";

export const inject = ["remote", "remote.credentials", "slots", "locale", "connection"];

export async function apply(ctx) {
  const disposers = [];
  try {
    const dispose = await ctx.remote.$mount(TYPERT_REMOTE);
    if (typeof dispose === "function") disposers.push(dispose);
  } catch (error) {
    for (const d of disposers.reverse()) await d();
    throw error;
  }

  const api = createSshApi(ctx);

  const localeDispose = ctx.locale.register(NS, {
    zh: {
      sshAction: "SSH 终端",
      sshActionClose: "关闭 SSH 终端"
    },
    en: {
      sshAction: "SSH Terminal",
      sshActionClose: "Close SSH terminal"
    }
  });
  if (typeof localeDispose === "function") disposers.push(localeDispose);

  // DSH does not expose an additive slot inside the session tab strip.  This
  // session-scoped contribution mounts a native button beside the existing
  // Conversation/Trajectory tabs, while preserving the current chat view and
  // the resizable right-side terminal drawer.
  const tabActionDispose = ctx.slots.inject("conversation.session.header.actions", () =>
    ctx.slots.register(
      {
        name: "conversation.session.header.actions",
        id: "ssh-ops-tab-action",
        order: 90,
        locale: NS
      },
      SshTabAction
    )
  );
  if (typeof tabActionDispose === "function") disposers.push(tabActionDispose);

  // The panel itself: a fixed right-side floating panel, mounted at the shell
  // overlay level so it spans the whole app frame regardless of conversation
  // scroll state.
  const panelDispose = ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "ssh-ops-panel",
        order: 100,
        locale: NS,
        inject: () => ({ api })
      },
      SshPanel
    )
  );
  if (typeof panelDispose === "function") disposers.push(panelDispose);

  // A real settings tab owns the durable server resource inventory.  The
  // session-header SSH button remains only a terminal visibility toggle.
  const resourcesDispose = ctx.slots.inject("settings.plugins.tab", () =>
    ctx.slots.register(
      {
        name: "settings.plugins.tab",
        id: "ssh-ops-resources",
        order: 80,
        label: "SSH 资源",
        locale: NS,
        inject: () => ({ api, credentials: ctx.remote?.credentials })
      },
      SshResources
    )
  );
  if (typeof resourcesDispose === "function") disposers.push(resourcesDispose);

  return async () => {
    for (const d of disposers.reverse()) await d();
  };
}

const SSH_TAB_SELECTOR = '[data-dsh-ssh-ops-tab="true"]';

/**
 * The settings dialog also owns a tablist.  SSH belongs only beside the
 * conversation / trajectory view tabs, never inside Settings → Plugins.
 */
function findConversationTablist() {
  return [...document.querySelectorAll('[role="tablist"]')].find((tablist) => {
    const text = tablist.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
    return (text.includes("对话") && text.includes("轨迹"))
      || (text.includes("conversation") && text.includes("trajectory"));
  });
}

function syncSshTabButton(button, open) {
  const activeClass = button.dataset.dshSshOpsActiveClass;
  if (activeClass) button.classList.toggle(activeClass, open);
  button.setAttribute("aria-pressed", open ? "true" : "false");
  button.title = open ? "关闭 SSH 终端" : "打开 SSH 终端";
  // The copied host tab class carries an underline.  Explicitly control it so
  // SSH only looks selected while the terminal drawer is actually open.
  button.style.setProperty(
    "color",
    open ? "var(--dsw-alias-brand, #2d6cdf)" : "var(--dsw-alias-label, currentColor)",
    "important"
  );
  button.style.setProperty(
    "border-bottom-color",
    open ? "var(--dsw-alias-brand, #2d6cdf)" : "transparent",
    "important"
  );
}

/**
 * Places a session-aware SSH trigger directly after the built-in view tabs.
 * It intentionally remains a button (rather than falsely claiming to be a
 * third conversation view) because it opens the adjacent terminal drawer and
 * does not replace the current chat/trajectory content.
 */
function SshTabAction() {
  const ui = useSshUi();

  React.useEffect(() => {
    const mount = () => {
      const tablist = findConversationTablist();
      if (!tablist) return;
      // An older plugin client used the first tablist on the page, which can
      // be Settings → Plugins. Remove that stale misplaced control whenever
      // the current client mounts, then keep exactly one in the chat tab bar.
      document.querySelectorAll(SSH_TAB_SELECTOR).forEach((button) => {
        if (!tablist.contains(button)) button.remove();
      });
      let button = tablist.querySelector(SSH_TAB_SELECTOR);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.dshSshOpsTab = "true";
        button.textContent = "SSH";
        button.setAttribute("aria-label", "SSH 终端");
        // Copy an unselected host tab.  Copying the first tab would also copy
        // its `tabActive` class, whose ::after pseudo-element leaves a bright
        // underline visible even while the SSH drawer is closed.
        const inactiveTab = tablist.querySelector('[role="tab"][aria-selected="false"]');
        const fallbackTab = tablist.querySelector('[role="tab"]');
        button.className = inactiveTab?.className ?? fallbackTab?.className.replace(/\S*tabActive\b/g, "").trim() ?? "";
        const selectedTab = tablist.querySelector('[role="tab"][aria-selected="true"]');
        const activeClass = [...(selectedTab?.classList ?? [])].find(
          (className) => /tabActive\b/.test(className) && !button.classList.contains(className)
        );
        if (activeClass) button.dataset.dshSshOpsActiveClass = activeClass;
        tablist.appendChild(button);
      }
      // Assignment (rather than addEventListener) makes remounts idempotent.
      button.onclick = () => sshUiSetOpen(!getSshUiSnapshot().open);
      syncSshTabButton(button, getSshUiSnapshot().open);
    };

    mount();
    // The chat tab strip re-renders constantly during message streaming; the
    // observer only needs to keep one button mounted, so coalesce bursts into
    // at most one scan per animation window instead of scanning on every DOM
    // mutation.
    let scheduled = false;
    let animationFrame = null;
    let disposed = false;
    const observer = new MutationObserver(() => {
      if (disposed || scheduled) return;
      scheduled = true;
      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        scheduled = false;
        if (disposed) return;
        mount();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      disposed = true;
      observer.disconnect();
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      document.querySelectorAll(SSH_TAB_SELECTOR).forEach((button) => button.remove());
    };
  }, []);

  React.useEffect(() => {
    document.querySelectorAll(SSH_TAB_SELECTOR).forEach((button) => syncSshTabButton(button, ui.open));
  }, [ui.open]);

  return null;
}
