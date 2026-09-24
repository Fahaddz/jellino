export function renderSetupPage(): string {
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jellino Setup</title>
<link rel="stylesheet" href="/remux-theme.css">
<link rel="stylesheet" href="/admin.css?v=nuvio6">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
</head>
<body>
<div class="jx-login-wrap">
  <div style="width: 100%; max-width: 480px; display: flex; flex-direction: column; gap: 20px;">
    <div class="card">
      <div class="card-header">
        <div style="display: flex; align-items: center; gap: 14px;">
          <img src="/logo-128.png" alt="Jellino" style="width: 44px; height: 44px; border-radius: 10px; flex-shrink: 0; box-shadow: 0 4px 12px rgba(0,0,0,0.25);">
          <div>
            <span class="card-title">Jellino Setup</span>
            <div class="jx-note" style="margin-top: 4px;">Welcome to Jellino &bull; Nuvio to Moonfin Gateway</div>
          </div>
        </div>
        <div class="theme-selector-container">
          <button class="theme-btn" type="button" data-theme-pick="auto">Auto</button>
          <button class="theme-btn" type="button" data-theme-pick="light">Light</button>
          <button class="theme-btn" type="button" data-theme-pick="dark">Dark</button>
        </div>
      </div>
      <div class="card-body">
        <div style="display: flex; flex-direction: column; gap: 16px;">
          <p class="jx-note" style="line-height: 1.6;">
            Jellino runs on your Nuvio account. Sign in below and Jellino will make your primary profile the administrator, import your profiles, addons, library layout, collections, and watch state, then take you to the dashboard.
          </p>
          <p class="jx-note" style="line-height: 1.6;">
            No Nuvio account yet? Create one in the Nuvio app or at
            <a href="https://nuvio.tv" target="_blank" rel="noreferrer">nuvio.tv</a>, then come back and sign in.
          </p>
          <div class="form-group">
            <label class="form-label" for="nuvio-email">Nuvio Email</label>
            <input id="nuvio-email" class="form-input" type="email" placeholder="you@example.com" autocomplete="email" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="nuvio-password">Nuvio Password</label>
            <input id="nuvio-password" class="form-input" type="password" placeholder="••••••••" autocomplete="current-password" required>
          </div>
          <button id="btn-nuvio-submit" class="btn btn-primary" type="button" style="width: 100%;">
            Sign in with Nuvio &amp; Launch
          </button>
        </div>

        <div id="alert-box" class="alert-error hidden"></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">What You Get</span>
      </div>
      <div class="jx-table">
        <div class="jx-row">
          <span style="display:inline-flex;align-items:center;opacity:0.7;flex-shrink:0;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg></span>
          <div class="jx-grow">
            <div class="session-name" style="font-size: .8rem;">Instant Playback</div>
            <div class="jx-sub">Sub-25ms browse response tailored for Moonfin</div>
          </div>
        </div>
        <div class="jx-row">
          <span style="display:inline-flex;align-items:center;opacity:0.7;flex-shrink:0;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg></span>
          <div class="jx-grow">
            <div class="session-name" style="font-size: .8rem;">Nuvio Sync</div>
            <div class="jx-sub">Bidirectional watch history, favorites &amp; collections</div>
          </div>
        </div>
        <div class="jx-row">
          <span style="display:inline-flex;align-items:center;opacity:0.7;flex-shrink:0;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
          <div class="jx-grow">
            <div class="session-name" style="font-size: .8rem;">Reliable Subtitles</div>
            <div class="jx-sub">Multi-encoding detection &amp; edge caching</div>
          </div>
        </div>
        <div class="jx-row">
          <span style="display:inline-flex;align-items:center;opacity:0.7;flex-shrink:0;"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>
          <div class="jx-grow">
            <div class="session-name" style="font-size: .8rem;">100% Free Tier</div>
            <div class="jx-sub">Zero VPS or server hardware needed</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
(function() {
  const store = window.localStorage;

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

  const alertBox = document.getElementById("alert-box");

  function showAlert(msg, isSuccess) {
    alertBox.textContent = msg;
    alertBox.className = isSuccess ? "alert-success" : "alert-error";
    alertBox.classList.remove("hidden");
  }

  function hideAlert() {
    alertBox.classList.add("hidden");
  }

  async function checkStatus() {
    try {
      const res = await fetch("/api/setup/status");
      const data = await res.json();
      if (data.adminExists) {
        window.location.href = "/admin";
      }
    } catch (err) {}
  }
  checkStatus();

  document.getElementById("btn-nuvio-submit").addEventListener("click", async () => {
    hideAlert();
    const email = document.getElementById("nuvio-email").value.trim();
    const password = document.getElementById("nuvio-password").value;
    if (!email || !password) {
      showAlert("Please enter your Nuvio email and password.");
      return;
    }
    const btn = document.getElementById("btn-nuvio-submit");
    btn.disabled = true;
    btn.innerHTML = "Connecting to Nuvio...";
    try {
      const res = await fetch("/api/setup/nuvio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) {
        btn.disabled = false;
        btn.innerHTML = "Sign in with Nuvio &amp; Launch";
        showAlert("Setup already completed. Redirecting to admin login...", true);
        setTimeout(() => { window.location.href = "/admin"; }, 1000);
        return;
      }
      if (!res.ok || !data.ok) {
        btn.disabled = false;
        btn.innerHTML = "Sign in with Nuvio &amp; Launch";
        showAlert(data.error || "Failed to authenticate with Nuvio. Check credentials.");
        return;
      }
      if (data.token) {
        localStorage.setItem("jellino-admin-token", data.token);
      }
      showAlert("Success! Redirecting to Admin Dashboard...", true);
      setTimeout(() => {
        window.location.href = "/admin";
      }, 500);
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = "Sign in with Nuvio &amp; Launch";
      showAlert("Network error connecting to Jellino server.");
    }
  });
})();
</script>
</body>
</html>`;
}
