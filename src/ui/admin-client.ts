export const ADMIN_CLIENT_JS = `const store = window.localStorage;
const jsonHeaders = { "content-type": "application/json" };

function token() {
  return store.getItem("jellino-admin-token") ?? "";
}

function authHeaders(extra) {
  const headers = Object.assign({}, extra ?? {});
  const current = token();
  if (current) headers["X-Emby-Authorization"] = \`MediaBrowser Client="admin", Token="\${current}"\`;
  return headers;
}

async function call(path, options) {
  const init = Object.assign({ headers: authHeaders(jsonHeaders) }, options ?? {});
  const res = await fetch(path, init);
  if (res.status === 401) {
    store.removeItem("jellino-admin-token");
    showLogin();
  }
  let body = null;
  try {
    body = await res.json();
  } catch (error) {
    body = null;
  }
  return { status: res.status, body };
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function toast(message, type) {
  const root = document.getElementById("toast-root") || document.body;
  const t = el("div", "jx-toast jx-toast-" + (type || "info"), message);
  root.appendChild(t);
  setTimeout(() => {
    t.classList.add("jx-toast-fade");
    setTimeout(() => t.remove(), 260);
  }, 3000);
}

function showLogin() {
  document.getElementById("login-view").classList.remove("hidden");
  document.getElementById("app-view").classList.add("hidden");
}

function showApp() {
  document.getElementById("login-view").classList.add("hidden");
  document.getElementById("app-view").classList.remove("hidden");
}

function applyTheme() {
  const theme = store.getItem("jellino-theme") || "auto";
  document.documentElement.setAttribute("data-theme", theme);
  for (const btn of document.querySelectorAll("[data-theme-pick]")) {
    btn.classList.toggle("active", btn.dataset.themePick === theme);
  }
}

for (const btn of document.querySelectorAll("[data-theme-pick]")) {
  btn.addEventListener("click", () => {
    store.setItem("jellino-theme", btn.dataset.themePick);
    applyTheme();
  });
}
applyTheme();

function openModal(title, bodyNodes, footerBtns, wide) {
  const root = document.getElementById("modal-root");
  const backdrop = el("div", "modal-backdrop");
  const modal = el(wide ? "modal modal--wide" : "modal");
  const header = el("div", "modal-header");
  header.appendChild(el("span", "modal-title", title));
  const body = el("div", "modal-body");
  for (const node of bodyNodes) body.appendChild(node);
  const footer = el("div", "modal-footer");
  function close() {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  }
  function onKey(event) {
    if (event.key === "Escape") close();
  }
  document.addEventListener("keydown", onKey);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  for (const btn of footerBtns) footer.appendChild(btn);
  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  backdrop.appendChild(modal);
  root.appendChild(backdrop);
  return close;
}

function primaryBtn(label, onClick) {
  const btn = el("button", "btn btn-primary", label);
  btn.type = "button";
  btn.addEventListener("click", onClick);
  return btn;
}

function ghostBtn(label, onClick) {
  const btn = el("button", "btn btn-ghost", label);
  btn.type = "button";
  btn.addEventListener("click", onClick);
  return btn;
}

function dangerBtn(label, onClick) {
  const btn = el("button", "btn btn-danger", label);
  btn.type = "button";
  btn.addEventListener("click", onClick);
  return btn;
}

function confirmDialog(message, onConfirm) {
  let close = null;
  const cancel = ghostBtn("Cancel", () => close());
  const confirm = dangerBtn("Confirm", async () => {
    close();
    await onConfirm();
  });
  close = openModal("Confirm", [el("p", null, message)], [cancel, confirm]);
}

function fieldGroup(labelText, inputEl, hint) {
  const group = el("div", "form-group");
  const label = el("label", "form-label", labelText);
  group.appendChild(label);
  group.appendChild(inputEl);
  if (hint) {
    const hintEl = el("span", "field-hint", hint);
    group.appendChild(hintEl);
  }
  return group;
}

function textInput(value, placeholder, type) {
  const input = el("input", "form-input");
  input.type = type || "text";
  input.value = value || "";
  if (placeholder) input.placeholder = placeholder;
  return input;
}

function switchEl(checked, onFlip) {
  const btn = el("button", "switch");
  btn.type = "button";
  btn.setAttribute("role", "switch");
  btn.dataset.state = checked ? "checked" : "unchecked";
  btn.appendChild(el("span", "switch-thumb"));
  btn.addEventListener("click", () => {
    const next = btn.dataset.state !== "checked";
    btn.dataset.state = next ? "checked" : "unchecked";
    onFlip(next);
  });
  return btn;
}

function badgeSpan(text, cls) {
  return el("span", cls || "addon-kind-type", text);
}

function cardShell(title, actionBtn) {
  const card = el("div", "card");
  const header = el("div", "card-header");
  header.appendChild(el("span", "card-title", title));
  if (actionBtn) header.appendChild(actionBtn);
  card.appendChild(header);
  const body = el("div", "card-body tight");
  card.appendChild(body);
  return { card, body };
}

function emptyState(box, message) {
  box.appendChild(el("div", "empty-state", message));
}

function kvRow(box, label, value) {
  const row = el("div", "kv-row");
  row.style.margin = "0 20px";
  row.appendChild(el("span", "kv-label", label));
  row.appendChild(el("span", "kv-value", value));
  box.appendChild(row);
}

function normalizeAddonUrl(url) {
  return String(url || "").trim().replace(/\\/+$/, "").replace(/\\/manifest\\.json$/i, "").replace(/\\/+$/, "");
}

const NAV_ICONS = {
  dashboard: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>',
  libraries: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/></svg>',
  addons: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>',
  profiles: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  settings: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>',
  logs: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
};

const ROUTES = [
  { id: "dashboard", title: "Dashboard" },
  { id: "libraries", title: "Libraries" },
  { id: "addons", title: "Addons & Sync" },
  { id: "profiles", title: "Profiles" },
  { id: "settings", title: "Settings" },
  { id: "logs", title: "Logs & Debug" },
];

function currentRoute() {
  const r = store.getItem("jellino-route") || "dashboard";
  if (r === "nuvio") return "addons";
  if (r === "users") return "profiles";
  if (r === "general") return "settings";
  return r;
}

function renderSidebar() {
  const nav = document.getElementById("sidebar-nav");
  nav.innerHTML = "";
  const active = currentRoute();
  for (const entry of ROUTES) {
    const btn = el("button", active === entry.id ? "nav-item nav-item-active" : "nav-item");
    btn.type = "button";
    const iconSpan = el("span", "nav-icon");
    iconSpan.style.display = "inline-flex";
    iconSpan.style.alignItems = "center";
    iconSpan.style.marginRight = "10px";
    iconSpan.style.opacity = active === entry.id ? "1" : "0.7";
    iconSpan.innerHTML = NAV_ICONS[entry.id] || "";
    btn.appendChild(iconSpan);
    btn.appendChild(el("span", null, entry.title));
    btn.addEventListener("click", () => {
      store.setItem("jellino-route", entry.id);
      document.getElementById("sidebar").classList.remove("sidebar-open");
      document.getElementById("sidebar-overlay").classList.add("hidden");
      render();
    });
    nav.appendChild(btn);
  }
}

document.getElementById("hamburger").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("sidebar-open");
  document.getElementById("sidebar-overlay").classList.toggle("hidden");
});

document.getElementById("sidebar-overlay").addEventListener("click", () => {
  document.getElementById("sidebar").classList.remove("sidebar-open");
  document.getElementById("sidebar-overlay").classList.add("hidden");
});

document.getElementById("signout").addEventListener("click", () => {
  store.removeItem("jellino-admin-token");
  showLogin();
});

let profilesCache = [];
let adminId = null;

async function refreshProfiles() {
  const res = await call("/api/admin/profiles");
  if (res.status !== 200) return false;
  profilesCache = res.body.Profiles ?? [];
  const admin = profilesCache.find((p) => p.admin);
  adminId = admin ? admin.id : null;
  return true;
}

function profileName(id) {
  const found = profilesCache.find((p) => p.id === id);
  return found ? found.name : id;
}

function initialAvatar(profile) {
  const avatar = el("div", "profile-avatar-circle", (profile.name || "U")[0].toUpperCase());
  if (profile.avatarColorHex) {
    avatar.style.backgroundColor = profile.avatarColorHex;
  } else {
    avatar.style.backgroundColor = profile.admin ? "#3b82f6" : "#8b5cf6";
  }
  return avatar;
}

function avatarNode(profile) {
  const url = typeof profile.avatarUrl === "string" && /^https?:/i.test(profile.avatarUrl) ? profile.avatarUrl : "";
  if (!url) return initialAvatar(profile);
  const img = el("img", "profile-avatar-img");
  img.src = url;
  img.alt = profile.name || "Profile";
  img.loading = "lazy";
  if (profile.avatarColorHex) {
    img.style.backgroundColor = profile.avatarColorHex;
  }
  img.addEventListener("error", () => img.replaceWith(initialAvatar(profile)));
  return img;
}

async function pageLibraries(page) {
  const { card, body } = cardShell("Libraries & Catalogs", null);
  page.appendChild(card);

  const intro = el(
    "p",
    "jx-note",
    "Control which library items, catalogs, and collections appear in Moonfin and Jellyfin clients. Use the switches below to show or hide items. Profiles that follow the primary admin inherit the admin's visibility settings automatically."
  );
  intro.style.padding = "14px 20px 0";
  body.appendChild(intro);

  const list = el("div", "jx-table");
  body.appendChild(list);

  if (profilesCache.length === 0) {
    await refreshProfiles();
  }

  if (profilesCache.length === 0) {
    emptyState(body, "No profiles found.");
    return;
  }

  const ordered = profilesCache.slice().sort((a, b) => (b.admin ? 1 : 0) - (a.admin ? 1 : 0));
  const libraryResults = await Promise.all(ordered.map((p) => call("/api/admin/profiles/" + p.id + "/libraries")));
  const dependentCountSubs = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const profile = ordered[index];
    const res = libraryResults[index];
    const data = (res && res.status === 200 && res.body) || { items: [], followsPrimary: false };
    const items = data.items || [];
    const followsPrimary = index > 0 && Boolean(data.followsPrimary);
    const visibleCount = items.filter((it) => it.enabled).length;

    const head = el("div", "jx-row");
    head.appendChild(avatarNode(profile));
    const headInfo = el("div", "jx-grow");
    const nameRow = el("div", null);
    nameRow.style.display = "flex";
    nameRow.style.alignItems = "center";
    nameRow.style.gap = "8px";
    nameRow.appendChild(el("div", "catalog-name", profile.name));
    if (profile.admin) nameRow.appendChild(badgeSpan("Primary", "user-badge user-badge-admin"));
    if (profile.nuvioProfileIndex !== null && profile.nuvioProfileIndex !== undefined) {
      nameRow.appendChild(badgeSpan("Nuvio #" + profile.nuvioProfileIndex, "addon-kind-type"));
    }
    headInfo.appendChild(nameRow);

    const countSub = el(
      "div",
      "jx-sub",
      followsPrimary
        ? "Follows primary library (" + visibleCount + " of " + items.length + " visible) \\u00b7 Inherited from Admin"
        : visibleCount + " of " + items.length + " visible in clients"
    );
    headInfo.appendChild(countSub);
    head.appendChild(headInfo);
    list.appendChild(head);

    if (followsPrimary) {
      dependentCountSubs.push(countSub);
      const noteRow = el("div", "jx-row addon-under-profile");
      const noteBox = el("div", "jx-grow");
      const noteText = el(
        "div",
        "jx-note",
        "Inherits all library visibility settings from the primary admin profile. Adjust the switches under " +
          (ordered[0]?.name || "the primary profile") +
          " above to show or hide libraries for this profile."
      );
      noteText.style.margin = "0";
      noteBox.appendChild(noteText);
      noteRow.appendChild(noteBox);
      list.appendChild(noteRow);
      continue;
    }

    if (items.length === 0) {
      const emptyRow = el("div", "jx-row addon-under-profile");
      emptyRow.appendChild(
        el("div", "jx-sub", "No library items found yet. Connect your Nuvio account in Addons & Sync or add addons first.")
      );
      list.appendChild(emptyRow);
      continue;
    }

    const updateCountLabel = () => {
      const curVisible = items.filter((it) => it.enabled).length;
      countSub.textContent = curVisible + " of " + items.length + " visible in clients";
      if (profile.admin) {
        for (const depSub of dependentCountSubs) {
          depSub.textContent = "Follows primary library (" + curVisible + " of " + items.length + " visible) \\u00b7 Inherited from Admin";
        }
      }
    };

    for (const item of items) {
      const row = el("div", "jx-row addon-under-profile");
      const mediaIcons = {
        collection: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>',
        movie: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="20" x="2" y="2" rx="2.18" ry="2.18"/><line x1="7" x2="7" y1="2" y2="22"/><line x1="17" x2="17" y1="2" y2="22"/><line x1="2" x2="22" y1="12" y2="12"/><line x1="2" x2="7" y1="7" y2="7"/><line x1="2" x2="7" y1="17" y2="17"/><line x1="17" x2="22" y1="17" y2="17"/><line x1="17" x2="22" y1="7" y2="7"/></svg>',
        series: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="15" x="2" y="7" rx="2" ry="2"/><polyline points="17 2 12 7 7 2"/></svg>',
        other: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>'
      };
      const icon = el("span", "catalog-icon");
      icon.style.display = "inline-flex";
      icon.style.alignItems = "center";
      icon.style.flexShrink = "0";
      icon.style.opacity = "0.7";
      icon.innerHTML = item.isCollection ? mediaIcons.collection : item.type === "movie" ? mediaIcons.movie : item.type === "series" ? mediaIcons.series : mediaIcons.other;
      row.appendChild(icon);

      const info = el("div", "jx-grow");
      info.appendChild(el("div", "catalog-name", item.name));
      const sub = el("div", "jx-sub", item.source || item.type);
      sub.style.marginTop = "2px";
      info.appendChild(sub);
      row.appendChild(info);

      const sw = switchEl(item.enabled, async (nextState) => {
        item.enabled = nextState;
        updateCountLabel();
        const putRes = await call("/api/admin/profiles/" + profile.id + "/libraries", {
          method: "PUT",
          body: JSON.stringify({ key: item.key, enabled: nextState }),
        });
        if (putRes.status === 200) {
          toast(item.name + " is now " + (nextState ? "shown" : "hidden") + " in clients", "success");
        } else {
          toast("Failed to update library visibility", "error");
          sw.dataset.state = !nextState ? "checked" : "unchecked";
          item.enabled = !nextState;
          updateCountLabel();
        }
      });
      row.appendChild(sw);
      list.appendChild(row);
    }
  }
}

async function pageAddons(page) {
  const [statusRes, usageRes] = await Promise.all([
    call("/api/admin/nuvio/status"),
    call("/api/admin/usage"),
  ]);

  const isConnected = statusRes.status === 200 && statusRes.body && statusRes.body.connected;
  const healthMap = new Map();
  for (const h of usageRes.body?.Health ?? []) {
    healthMap.set(h.addonUrl, h);
  }

  if (isConnected) {
    const { card, body } = cardShell("Nuvio Integration", null);
    page.appendChild(card);

    const pad = el("div", "jx-pad");
    const statusRow = el("div", "jx-row");
    statusRow.style.padding = "0";

    const badge = el("div", "account-badge", "✓");
    badge.style.background = "#22c55e";
    badge.style.color = "#ffffff";
    badge.style.fontWeight = "bold";

    const info = el("div", "jx-grow");
    info.appendChild(el("div", "catalog-name", statusRes.body.email || "Nuvio Account"));
    const lastSyncText = statusRes.body.lastSync
      ? "Last synced " + new Date(statusRes.body.lastSync * 1000).toLocaleString()
      : "Not synced yet";
    info.appendChild(el("div", "jx-sub", lastSyncText + " \u00b7 Token " + (statusRes.body.tokenStatus || "valid")));
    statusRow.appendChild(badge);
    statusRow.appendChild(info);

    const actions = el("div", "jx-actions");
    const syncBtn = primaryBtn("Sync Now", async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = "Syncing...";
      const syncRes = await call("/api/admin/nuvio/sync", { method: "POST" });
      syncBtn.disabled = false;
      syncBtn.textContent = "Sync Now";
      if (syncRes.status === 200 && syncRes.body && syncRes.body.ok) {
        toast("Synced successfully with Nuvio", "success");
        await refreshProfiles();
        await render();
      } else {
        const msg = (syncRes.body && syncRes.body.error) || syncRes.status;
        toast("Sync failed: " + msg, "error");
      }
    });

    const openNuvioBtn = document.createElement("a");
    openNuvioBtn.className = "btn btn-ghost";
    openNuvioBtn.href = "https://nuvio.tv/account?tab=addons";
    openNuvioBtn.target = "_blank";
    openNuvioBtn.rel = "noopener noreferrer";
    openNuvioBtn.textContent = "Manage in Nuvio";

    const disconnectBtn = dangerBtn("Disconnect", () => {
      confirmDialog("Disconnect from Nuvio? Synced profiles will remain in Jellino.", async () => {
        const discRes = await call("/api/admin/nuvio/disconnect", { method: "POST" });
        if (discRes.status === 200) {
          toast("Disconnected from Nuvio", "info");
          await render();
        } else {
          toast("Disconnect failed: " + ((discRes.body && discRes.body.error) || discRes.status), "error");
        }
      });
    });

    actions.appendChild(syncBtn);
    actions.appendChild(openNuvioBtn);
    actions.appendChild(disconnectBtn);
    statusRow.appendChild(actions);

    pad.appendChild(statusRow);
    body.appendChild(pad);

    const addonsCard = cardShell("Synced Addons by Profile", null);
    page.appendChild(addonsCard.card);
    const addonsList = el("div", "jx-table");
    addonsCard.body.appendChild(addonsList);

    const ordered = profilesCache.slice().sort((a, b) => (b.admin ? 1 : 0) - (a.admin ? 1 : 0));
    const results = await Promise.all(ordered.map((p) => call("/api/admin/profiles/" + p.id + "/addons")));

    let primarySignature = null;
    for (let index = 0; index < ordered.length; index += 1) {
      const profile = ordered[index];
      const res = results[index];
      const addons = (res && res.status === 200 && res.body && res.body.addons) || [];
      const signature = addons.map((a) => a.url + ":" + (a.enabled ? "1" : "0")).sort().join(",");
      if (index === 0) {
        primarySignature = signature;
      }

      const head = el("div", "jx-row");
      head.appendChild(avatarNode(profile));
      const headInfo = el("div", "jx-grow");
      const nameRow = el("div", null);
      nameRow.style.display = "flex";
      nameRow.style.alignItems = "center";
      nameRow.style.gap = "8px";
      nameRow.appendChild(el("div", "catalog-name", profile.name));
      if (profile.admin) nameRow.appendChild(badgeSpan("Primary", "user-badge user-badge-admin"));
      if (profile.nuvioProfileIndex !== null && profile.nuvioProfileIndex !== undefined) {
        nameRow.appendChild(badgeSpan("Nuvio #" + profile.nuvioProfileIndex, "addon-kind-type"));
      }
      headInfo.appendChild(nameRow);

      const followsPrimary = index > 0 && (profile.usesPrimaryAddons || (primarySignature !== null && primarySignature.length > 0 && signature === primarySignature));
      if (followsPrimary) {
        headInfo.appendChild(el("div", "jx-sub", "Follows primary addons (" + addons.length + ")"));
      } else {
        headInfo.appendChild(el("div", "jx-sub", addons.length + (addons.length === 1 ? " addon" : " addons")));
      }
      head.appendChild(headInfo);
      addonsList.appendChild(head);

      if (followsPrimary) continue;
      if (addons.length === 0) {
        emptyState(addonsList, "No addons synced yet. Click 'Sync Now' above to pull addons from Nuvio.");
        continue;
      }
      for (const addon of addons) {
        const row = el("div", "jx-row addon-under-profile");
        const aInfo = el("div", "jx-grow");
        const aNameRow = el("div", null);
        aNameRow.style.display = "flex";
        aNameRow.style.alignItems = "center";
        aNameRow.style.gap = "8px";
        aNameRow.appendChild(el("div", "catalog-name", addon.name || addon.url));

        const health = healthMap.get(addon.url);
        if (health && health.fails > 0) {
          const failBadge = el("span", "addon-health-badge addon-health-fail", "Failing (" + health.fails + ")");
          failBadge.title = "Last error: " + (health.lastError || "unknown");
          aNameRow.appendChild(failBadge);
        } else {
          aNameRow.appendChild(el("span", "addon-health-badge addon-health-ok", "Healthy"));
        }
        aInfo.appendChild(aNameRow);

        const subLine = el("div", "jx-sub", addon.url);
        subLine.style.marginTop = "4px";
        aInfo.appendChild(subLine);

        if (Array.isArray(addon.resources) && addon.resources.length > 0) {
          const resRow = el("div", null);
          resRow.style.display = "flex";
          resRow.style.gap = "4px";
          resRow.style.marginTop = "4px";
          for (const r of addon.resources) resRow.appendChild(el("span", "addon-resource-tag", r));
          aInfo.appendChild(resRow);
        }
        row.appendChild(aInfo);
        row.appendChild(
          addon.enabled
            ? badgeSpan("Active", "user-badge user-badge-admin")
            : badgeSpan("Disabled", "task-badge task-badge-idle"),
        );
        addonsList.appendChild(row);
      }
    }
  } else {
    const { card, body } = cardShell("Connect Nuvio Account", null);
    page.appendChild(card);

    const pad = el("div", "jx-pad");
    const desc = el(
      "p",
      "jx-note",
      "Connect your Nuvio account to automatically import all your profiles, addons, and watch states to Jellino. In Moonfin or any Jellyfin app, family members can log in using their profile name."
    );
    desc.style.fontSize = "0.85rem";
    desc.style.lineHeight = "1.5";
    pad.appendChild(desc);

    const emailInput = el("input", "form-input");
    emailInput.type = "email";
    emailInput.placeholder = "you@example.com";

    const passInput = el("input", "form-input");
    passInput.type = "password";
    passInput.placeholder = "Your Nuvio password";

    const errBox = el("div", "jx-error hidden");

    const connectBtn = primaryBtn("Connect to Nuvio", async () => {
      const email = emailInput.value.trim();
      const password = passInput.value;
      if (!email || !password) {
        errBox.textContent = "Email and password are required.";
        errBox.classList.remove("hidden");
        return;\n      }
      errBox.classList.add("hidden");
      connectBtn.disabled = true;
      connectBtn.textContent = "Connecting...";

      const res = await call("/api/admin/nuvio/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });

      connectBtn.disabled = false;
      connectBtn.textContent = "Connect to Nuvio";

      if (res.status === 200 && res.body && res.body.ok) {
        toast("Connected to Nuvio!", "success");
        await refreshProfiles();
        await render();
      } else {
        errBox.textContent = (res.body && res.body.error) || "Failed to connect to Nuvio. Check credentials.";
        errBox.classList.remove("hidden");
      }
    });

    pad.appendChild(fieldGroup("Nuvio Email", emailInput));
    pad.appendChild(fieldGroup("Nuvio Password", passInput));
    pad.appendChild(errBox);

    const btnRow = el("div", "jx-actions");
    btnRow.style.marginTop = "10px";
    btnRow.appendChild(connectBtn);
    pad.appendChild(btnRow);

    body.appendChild(pad);

    const localCard = cardShell("Custom Addon Manager (Standalone)", null);
    page.appendChild(localCard.card);
    const localPad = el("div", "jx-pad");
    const profileSelect = el("select", "form-input");
    for (const p of profilesCache) {
      const opt = el("option");
      opt.value = p.id;
      opt.textContent = p.name + (p.admin ? " (Admin)" : "");
      profileSelect.appendChild(opt);
    }
    localPad.appendChild(fieldGroup("Select Profile", profileSelect));
    localCard.body.appendChild(localPad);
    const localContent = el("div", "jx-table");
    localCard.body.appendChild(localContent);

    async function loadStandaloneAddons(pId) {
      localContent.innerHTML = "";
      const addonsRes = await call(\`/api/admin/profiles/\${pId}/addons\`);
      if (addonsRes.status !== 200) {
        emptyState(localContent, "Could not load addons.");
        return;
      }
      let currentAddons = (addonsRes.body?.addons || []).map((a) => Object.assign({}, a));
      const addRow = el("div", "jx-pad");
      addRow.style.display = "flex";
      addRow.style.gap = "8px";
      const urlInput = el("input", "form-input");
      urlInput.type = "url";
      urlInput.placeholder = "https://example.com/manifest.json";
      urlInput.style.flex = "1";
      const addBtn = primaryBtn("+ Add Addon", () => {
        const u = normalizeAddonUrl(urlInput.value);
        if (!u.startsWith("http")) return toast("Valid URL required", "error");
        currentAddons.push({ url: u, name: u.split("/")[2] || u, enabled: true, position: currentAddons.length });
        urlInput.value = "";
        renderLocalList();
      });
      addRow.appendChild(urlInput);
      addRow.appendChild(addBtn);
      localContent.appendChild(addRow);

      const itemsBox = el("div", "jx-table");
      localContent.appendChild(itemsBox);

      function renderLocalList() {
        itemsBox.innerHTML = "";
        if (currentAddons.length === 0) emptyState(itemsBox, "No addons added.");
        currentAddons.forEach((a, i) => {
          const row = el("div", "jx-row");
          const info = el("div", "jx-grow");
          info.appendChild(el("div", "catalog-name", a.name || a.url));
          info.appendChild(el("div", "jx-sub", a.url));
          row.appendChild(info);
          const del = dangerBtn("Remove", () => {
            currentAddons.splice(i, 1);
            renderLocalList();
          });
          row.appendChild(del);
          itemsBox.appendChild(row);
        });
      }
      renderLocalList();

      const saveBar = el("div", "jx-pad");
      const saveBtn = primaryBtn("Save Addons", async () => {
        saveBtn.disabled = true;
        const res = await call(\`/api/admin/profiles/\${pId}/addons\`, {
          method: "PUT",
          body: JSON.stringify({ mode: "custom", addons: currentAddons }),
        });
        saveBtn.disabled = false;
        if (res.status === 200) toast("Addons saved", "success");
        else toast("Save failed", "error");
      });
      saveBar.appendChild(saveBtn);
      localContent.appendChild(saveBar);
    }

    profileSelect.addEventListener("change", () => loadStandaloneAddons(profileSelect.value));
    if (profilesCache[0]) loadStandaloneAddons(profilesCache[0].id);
  }
}

async function pageNuvio(page) {
  return pageAddons(page);
}

function openPasswordModal(page, profile) {
  const passInput = textInput("", "8+ characters");
  passInput.type = "password";
  passInput.autocomplete = "new-password";

  const note = el(
    "p",
    "jx-note",
    "Passwords are required to sign in directly from client apps. Alternatively, authorize a Quick Connect 6-digit code on the Dashboard."
  );

  const bodyNodes = [note, fieldGroup("Password", passInput)];
  let close = null;
  const cancel = ghostBtn("Cancel", () => close());
  const save = primaryBtn("Save Password", async () => {
    const password = passInput.value;
    if (password.length < 8) {
      toast("Password must be at least 8 characters.", "error");
      return;
    }
    close();
    const res = await call("/api/admin/profiles/" + profile.id + "/password", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    if (res.status !== 200) toast("Failed: " + ((res.body && res.body.error) || res.status), "error");
    else toast("Password updated", "success");
    await refreshProfiles();
    render();
  });

  close = openModal("Moonfin Password: " + profile.name, bodyNodes, [cancel, save], false);
}

async function pageProfiles(page) {
  const { card, body } = cardShell("Profiles", null);
  page.appendChild(card);
  const intro = el(
    "p",
    "jx-note",
    "Profiles imported from your Nuvio account and exposed to Moonfin as Jellyfin users. Addons, library layout, and watch state follow each profile."
  );
  intro.style.padding = "14px 20px 0";
  body.appendChild(intro);
  const list = el("div", "jx-table");
  body.appendChild(list);
  if (profilesCache.length === 0) emptyState(body, "No profiles found.");
  const me = profilesCache.find((p) => p.admin);
  for (const profile of profilesCache) {
    const row = el("div", "jx-row");

    row.appendChild(avatarNode(profile));

    const info = el("div", "user-info jx-grow");
    const nameRow = el("div", null);
    nameRow.appendChild(el("span", "user-name", profile.name));
    if (profile.admin) nameRow.appendChild(badgeSpan("Admin", "user-badge user-badge-admin"));
    if (me && profile.id === me.id) nameRow.appendChild(badgeSpan("You", "user-badge user-badge-self"));
    if (profile.disabled) nameRow.appendChild(badgeSpan("Disabled", "user-badge user-badge-self"));
    if (profile.nuvioProfileId) nameRow.appendChild(badgeSpan("Nuvio Imported", "addon-kind-badge"));
    if (profile.nuvioProfileIndex !== null && profile.nuvioProfileIndex !== undefined) {
      nameRow.appendChild(badgeSpan("Nuvio #" + profile.nuvioProfileIndex, "addon-kind-type"));
    }
    info.appendChild(nameRow);

    const sub = el("div", "jx-sub");
    const loginLine = profile.hasPassword
      ? "Moonfin login: Password configured"
      : "Moonfin login: No password set \\u2014 set one or authorize via Quick Connect";
    if (profile.nuvioProfileId) {
      sub.textContent = "Nuvio imported profile \\u00b7 " + loginLine;
    } else {
      sub.textContent = "Local profile \\u00b7 " + loginLine;
    }
    info.appendChild(sub);
    row.appendChild(info);

    const actions = el("div", "jx-actions");
    actions.appendChild(ghostBtn("Password", () => openPasswordModal(page, profile)));
    row.appendChild(actions);
    list.appendChild(row);
  }
}

async function pageUsers(page) {
  return pageProfiles(page);
}

async function pageDashboard(page) {
  const { card, body } = cardShell("Server Status", null);
  page.appendChild(card);
  const info = el("div", "jx-pad");
  info.style.gap = "0";
  kvRow(info, "Server", "Jellino");
  try {
    const health = await call("/health");
    kvRow(info, "Gateway Status", health.status === 200 ? "Online (Healthy)" : \`HTTP \${health.status}\`);
  } catch (error) {
    kvRow(info, "Gateway Status", "Unreachable");
  }
  kvRow(info, "Active Profiles", String(profilesCache.length));
  try {
    const version = await call("/api/version");
    if (version.status === 200 && version.body.build) {
      kvRow(info, "Version", \`\${version.body.build}\${version.body.date ? \` (\${version.body.date})\` : ""}\`);
    }
  } catch (error) {
    void error;
  }
  body.appendChild(info);

  const qcCard = cardShell("Quick Connect Device Pairing", null);
  page.appendChild(qcCard.card);
  const qcBox = el("div", "jx-pad");
  qcBox.appendChild(el("p", "jx-note", "Enter the 6-digit code shown on Moonfin (Apple TV, iOS, macOS, Android) to authorize instant sign-in without a password."));

  const qcContainer = el("div", "qc-container");
  const qcRow = el("div", "qc-input-row");

  const codeInput = el("input", "qc-code-input");
  codeInput.type = "text";
  codeInput.placeholder = "000 000";
  codeInput.maxLength = 7;
  codeInput.autocomplete = "off";

  codeInput.addEventListener("input", () => {
    let raw = codeInput.value.replace(/\\D/g, "").slice(0, 6);
    if (raw.length > 3) {
      codeInput.value = raw.slice(0, 3) + " " + raw.slice(3);
    } else {
      codeInput.value = raw;
    }
  });

  const profileSelect = el("select", "form-input");
  profileSelect.style.width = "auto";
  profileSelect.style.minWidth = "180px";
  for (const p of profilesCache) {
    const opt = el("option");
    opt.value = p.id;
    opt.textContent = p.name + (p.admin ? " (Admin)" : "");
    profileSelect.appendChild(opt);
  }

  const feedbackBox = el("div", "qc-feedback");

  const authBtn = primaryBtn("Authorize Device", async () => {
    const cleanCode = codeInput.value.replace(/\\D/g, "");
    if (cleanCode.length !== 6) {
      feedbackBox.className = "qc-feedback qc-feedback-error show";
      feedbackBox.textContent = "Please enter a valid 6-digit numeric code.";
      toast("Enter a 6-digit code", "error");
      return;
    }
    const profileId = profileSelect.value;
    authBtn.disabled = true;
    authBtn.textContent = "Authorizing...";
    feedbackBox.className = "qc-feedback";
    try {
      const res = await call(\`/QuickConnect/Authorize?code=\${cleanCode}\`, {
        method: "POST",
        body: JSON.stringify({ code: cleanCode, profileId }),
      });
      authBtn.disabled = false;
      authBtn.textContent = "Authorize Device";
      if (res.status === 200) {
        codeInput.value = "";
        const targetName = profilesCache.find((p) => p.id === profileId)?.name || "Profile";
        feedbackBox.className = "qc-feedback qc-feedback-success show";
        feedbackBox.textContent = \`Device authorized successfully for \${targetName}! The TV app will log in immediately.\`;
        toast("Quick Connect authorized!", "success");
      } else {
        const msg = res.body?.error || "Code not found, expired, or already used.";
        feedbackBox.className = "qc-feedback qc-feedback-error show";
        feedbackBox.textContent = \`Authorization failed: \${msg}\`;
        toast("Failed: " + msg, "error");
      }
    } catch {
      authBtn.disabled = false;
      authBtn.textContent = "Authorize Device";
      feedbackBox.className = "qc-feedback qc-feedback-error show";
      feedbackBox.textContent = "Network error while authorizing.";
      toast("Network error", "error");
    }
  });

  qcRow.appendChild(codeInput);
  qcRow.appendChild(profileSelect);
  qcRow.appendChild(authBtn);
  qcContainer.appendChild(qcRow);
  qcContainer.appendChild(feedbackBox);
  qcBox.appendChild(qcContainer);
  qcCard.body.appendChild(qcBox);
}

async function pageSettings(page) {
  const { card, body } = cardShell("Settings", null);
  page.appendChild(card);
  const keyInput = textInput("", "PublicMetaDB API key (optional)");
  keyInput.type = "password";
  const tmdbInput = textInput("", "TMDB API key (optional)");
  tmdbInput.type = "password";
  const status = el("div", "jx-sub");
  const saveBtn = primaryBtn("Save", async () => {
    const res = await call("/api/admin/settings", {
      method: "PUT",
      body: JSON.stringify({ publicMetaDbKey: keyInput.value.trim(), tmdbApiKey: tmdbInput.value.trim() }),
    });
    if (res.status !== 200) {
      status.textContent = "Save failed: " + ((res.body && res.body.error) || res.status);
      return;
    }
    status.textContent = "";
    toast("Settings saved.", "success");
    await load();
  });
  body.appendChild(fieldGroup("PublicMetaDB API key", keyInput, "Optional. When set, intro and outro lookups ask PublicMetaDB first, then AniSkip, then IntroDB."));
  body.appendChild(fieldGroup("TMDB API key", tmdbInput, "Optional. When set, person pages get biography, birthday, birthplace, and photos from TMDB."));
  const pad = el("div", "jx-pad");
  pad.appendChild(saveBtn);
  body.appendChild(pad);
  body.appendChild(status);
  async function load() {
    const res = await call("/api/admin/settings");
    if (res.status !== 200) return;
    keyInput.value = res.body.publicMetaDbKey || "";
    tmdbInput.value = res.body.tmdbApiKey || "";
  }
  await load();
}

async function pageGeneral(page) {
  return pageSettings(page);
}

async function pageLogs(page) {
  const CATEGORIES = [
    ["", "All"],
    ["subtitle", "Subtitles"],
    ["stream", "Streams"],
    ["meta", "Metadata"],
    ["catalog", "Catalogs"],
    ["sync", "Sync"],
    ["playstate", "Playstate"],
    ["level:error", "Errors"],
  ];
  let activeCategory = "";
  let lastEntries = [];

  const headerActions = el("div", "jx-actions");
  headerActions.appendChild(ghostBtn("Refresh", () => loadLogs()));
  headerActions.appendChild(ghostBtn("Copy All", async () => {
    try {
      await navigator.clipboard.writeText(lastEntries.map((row) => formatLine(row)).join("\\n"));
      toast("Logs copied.", "success");
    } catch (err) {
      toast("Clipboard unavailable.", "error");
    }
  }));
  headerActions.appendChild(dangerBtn("Clear", async () => {
    await call("/api/admin/app-log", { method: "DELETE" });
    toast("Log cleared.", "success");
    loadLogs();
  }));

  const logCard = cardShell("Debug Log", headerActions);
  page.appendChild(logCard.card);

  const filterWrap = el("div", "sub-filter-tabs");
  filterWrap.style.padding = "14px 20px 0";
  for (const option of CATEGORIES) {
    const btn = el("button", "sub-filter-btn" + (option[0] === "" ? " active" : ""), option[1]);
    btn.type = "button";
    btn.addEventListener("click", () => {
      activeCategory = option[0];
      for (const other of filterWrap.querySelectorAll(".sub-filter-btn")) other.classList.remove("active");
      btn.classList.add("active");
      loadLogs();
    });
    filterWrap.appendChild(btn);
  }
  logCard.body.appendChild(filterWrap);

  const logBox = el("div", "jx-table");
  logCard.body.appendChild(logBox);
  logCard.body.appendChild(el("p", "jx-note", "Unified log for subtitles, streams, metadata, catalogs, and Nuvio sync."));

  function formatLine(row) {
    const when = typeof row.at === "number" && row.at > 0 ? new Date(row.at * 1000).toISOString() : "?";
    const who = profileName(row.profileId) || row.profileId || "system";
    return \`\${when} [\${row.level}] \${row.category || "app"}/\${row.kind} \${who} :: \${row.message}\${row.url ? " :: " + row.url : ""}\`;
  }

  async function loadLogs() {
    logBox.innerHTML = "";
    logBox.appendChild(el("div", "loading-text", "Loading logs..."));
    const query = !activeCategory
      ? "/api/admin/app-log?limit=100"
      : activeCategory.indexOf("level:") === 0
        ? \`/api/admin/app-log?limit=100&level=\${encodeURIComponent(activeCategory.slice(6))}\`
        : \`/api/admin/app-log?limit=100&category=\${encodeURIComponent(activeCategory)}\`;
    const res = await call(query);
    logBox.innerHTML = "";
    lastEntries = res.status === 200 ? (res.body.entries || []) : [];
    if (lastEntries.length === 0) {
      emptyState(logBox, activeCategory ? "No events in this category yet." : "No events yet. Sync Nuvio or play something.");
      return;
    }
    for (const row of lastEntries) {
      const line = el("div", "jx-row");
      const infoBox = el("div", "jx-grow");
      infoBox.appendChild(el("div", "catalog-name", "[" + row.level + "] " + (row.category || "app") + " - " + row.kind));
      const detail = el("div", "jx-sub", row.message || "");
      detail.style.wordBreak = "break-word";
      infoBox.appendChild(detail);
      const when = typeof row.at === "number" && row.at > 0 ? new Date(row.at * 1000).toLocaleString() : "unknown time";
      infoBox.appendChild(el("div", "jx-sub", when + " \u00b7 " + (profileName(row.profileId) || row.profileId || "system")));
      line.appendChild(infoBox);
      logBox.appendChild(line);
    }
  }
  loadLogs();
}

const PAGES = {
  dashboard: { title: "Dashboard", render: pageDashboard },
  libraries: { title: "Libraries & Catalogs", render: pageLibraries },
  addons: { title: "Addons & Sync", render: pageAddons },
  nuvio: { title: "Addons & Sync", render: pageNuvio },
  profiles: { title: "Profiles", render: pageProfiles },
  users: { title: "Profiles", render: pageUsers },
  settings: { title: "Settings", render: pageSettings },
  general: { title: "Settings", render: pageGeneral },
  logs: { title: "Logs & Debug", render: pageLogs },
};

async function render() {
  renderSidebar();
  const route = currentRoute();
  const pageDef = PAGES[route] || PAGES.dashboard;
  document.getElementById("page-title").textContent = pageDef.title;
  const page = document.getElementById("page");
  page.innerHTML = "";
  document.getElementById("modal-root").innerHTML = "";
  try {
    await pageDef.render(page);
  } catch (err) {
    page.innerHTML = "";
    const box = el("div", "card");
    const body = el("div", "card-body");
    body.appendChild(el("p", "jx-note", "This page failed to load: " + (err && err.message ? err.message : String(err))));
    box.appendChild(body);
    page.appendChild(box);
  }
}

async function boot() {
  const ok = await refreshProfiles();
  if (!ok) return;
  render();
}

document.getElementById("login-go").addEventListener("click", async () => {
  const email = document.getElementById("login-name").value.trim();
  const password = document.getElementById("login-password").value;
  const message = document.getElementById("login-message");
  message.textContent = "";
  if (!email || !password) {
    message.textContent = "Please enter your Nuvio email and password.";
    return;
  }
  const btn = document.getElementById("login-go");
  btn.disabled = true;
  btn.textContent = "Signing in...";
  try {
    const res = await call("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 200 && res.body && res.body.token) {
      store.setItem("jellino-admin-token", res.body.token);
      message.textContent = "";
      showApp();
      await boot();
    } else {
      message.textContent = (res.body && res.body.error) || "Sign in failed. Check your Nuvio credentials.";
    }
  } catch (err) {
    message.textContent = "Sign in failed. Check your Nuvio credentials.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in with Nuvio";
  }
});
document.getElementById("login-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("login-go").click();
});
document.getElementById("login-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("login-go").click();
});

if (token()) {
  showApp();
  boot();
} else {
  showLogin();
}
`;
