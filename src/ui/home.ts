import { SERVER_VERSION } from "../version";

export function renderHomePage(serverName = "Jellino", serverVersion = SERVER_VERSION): string {
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${serverName} &bull; Jellyfin Gateway</title>
<link rel="stylesheet" href="/remux-theme.css">
<link rel="stylesheet" href="/admin.css?v=nuvio8">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
</head>
<body>
<div class="jx-login-wrap">
  <div style="width: 100%; max-width: 520px; display: flex; flex-direction: column; gap: 20px;">
    <div class="card">
      <div class="card-header">
        <div style="display: flex; align-items: center; gap: 14px;">
          <img src="/logo-128.png" alt="Jellino" style="width: 44px; height: 44px; border-radius: 10px; flex-shrink: 0; box-shadow: 0 4px 12px rgba(0,0,0,0.25);">
          <div>
            <span class="card-title">${serverName} Server</span>
            <div class="jx-note" style="margin-top: 4px;">v${serverVersion} &bull; Online &mdash; lightweight Jellyfin bridge for Nuvio</div>
          </div>
        </div>
        <div class="theme-selector-container">
          <button class="theme-btn" type="button" data-theme-pick="auto">Auto</button>
          <button class="theme-btn" type="button" data-theme-pick="light">Light</button>
          <button class="theme-btn" type="button" data-theme-pick="dark">Dark</button>
        </div>
      </div>
      <div class="card-body">
        <div class="form-panel">
          <div class="form-panel-title">How to Connect Your Device</div>
          <ol style="margin: 0; padding-left: 20px; font-size: .82rem; line-height: 1.7; color: var(--text);">
            <li>Open <strong>Moonfin</strong>, <strong>Odin</strong>, or any Jellyfin app on Apple TV, iOS, Android, or PC.</li>
            <li>Enter this server's URL:
              <div style="display: flex; gap: 8px; margin-top: 6px; margin-bottom: 6px; align-items: center;">
                <code id="server-url" style="flex: 1; background: var(--primary-dim); color: var(--primary); padding: 6px 10px; border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: .75rem; word-break: break-all; border: 1px solid var(--primary-glow);">window.location.origin</code>
                <button id="copy-url-btn" class="btn btn-ghost" type="button" style="padding: 4px 10px; font-size: .75rem; flex-shrink: 0;">Copy</button>
              </div>
            </li>
            <li>Sign in using your <strong>Profile name &amp; password</strong> (set in Admin Dashboard), or use <strong>Quick Connect</strong> for instant TV pairing without typing a password.</li>
          </ol>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px;">
          <a href="/admin" class="btn btn-primary" style="width: 100%;">
            Open Admin Dashboard
          </a>
          <a href="/admin" class="btn btn-ghost" id="quick-connect-link" style="width: 100%;">
            Authorize Quick Connect Code
          </a>
          <a href="/System/Info/Public" class="btn btn-ghost" style="width: 100%;">
            View Server Info (JSON)
          </a>
        </div>
      </div>
    </div>

    <div style="display: flex; justify-content: center; align-items: center;">
      <a href="https://github.com/Fahaddz/jellino" target="_blank" rel="noopener noreferrer" class="btn btn-ghost" style="display: inline-flex; align-items: center; gap: 8px; font-size: .82rem; color: var(--text-dim); text-decoration: none; padding: 8px 16px;">
        <svg height="18" width="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
        </svg>
        <span>Fahaddz/jellino on GitHub</span>
      </a>
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

  const url = window.location.origin;
  const urlEl = document.getElementById("server-url");
  if (urlEl) urlEl.textContent = url;

  const copyBtn = document.getElementById("copy-url-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
      } catch {
        copyBtn.textContent = "Copied";
      }
    });
  }

  const qcLink = document.getElementById("quick-connect-link");
  if (qcLink) {
    qcLink.addEventListener("click", () => {
      store.setItem("jellino-route", "dashboard");
    });
  }
})();
</script>
</body>
</html>`;
}
