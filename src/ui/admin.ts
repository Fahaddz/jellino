export function renderAdminPage(buildId = "1"): string {
  return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jellino Admin</title>
<link rel="stylesheet" href="/remux-theme.css">
<link rel="stylesheet" href="/admin.css?v=${buildId}">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
</head>
<body>
<div id="login-view" class="jx-login-wrap hidden">
  <div class="card jx-login-card">
    <div class="card-header">
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px;">
        <img src="/logo-128.png" alt="Jellino" style="width:36px; height:36px; border-radius:8px; flex-shrink:0; box-shadow: 0 4px 12px rgba(0,0,0,0.25);">
        <span class="card-title">Jellino Admin</span>
      </div>
      <div class="card-subtitle">Sign in with your Nuvio account to manage Jellino</div>
    </div>
    <div class="card-body">
      <div class="form-group">
        <label class="form-label" for="login-name">Nuvio Email</label>
        <input id="login-name" class="form-input" type="email" autocomplete="email" placeholder="name@example.com" maxlength="64">
      </div>
      <div class="form-group">
        <label class="form-label" for="login-password">Nuvio Password</label>
        <input id="login-password" class="form-input" type="password" autocomplete="current-password" placeholder="Password" maxlength="256">
      </div>
      <button id="login-go" class="btn btn-primary" type="button">Sign in with Nuvio</button>
      <p id="login-message" class="jx-note" style="margin-top: 10px;"></p>
    </div>
  </div>
</div>

<div id="app-view" class="hidden">
  <div class="layout">
    <div id="sidebar-overlay" class="sidebar-overlay hidden"></div>
    <nav id="sidebar" class="sidebar">
      <div class="sidebar-brand">
        <h1 class="brand-title" style="margin:0; display:flex; align-items:center; gap:10px;">
          <img src="/logo-128.png" alt="Jellino" style="width:24px; height:24px; border-radius:6px; flex-shrink:0;"> Jellino
        </h1>
      </div>
      <div id="sidebar-nav" class="sidebar-nav"></div>
      <div class="sidebar-footer">
        <button id="signout" class="btn btn-ghost" type="button" style="width:100%">Sign Out</button>
      </div>
    </nav>
    <div class="main">
      <div class="main-header">
        <div style="display:flex;align-items:center;gap:12px">
          <button id="hamburger" class="hamburger" type="button">☰</button>
          <h2 id="page-title" class="main-title"></h2>
        </div>
        <div class="theme-selector-container">
          <button class="theme-btn" type="button" data-theme-pick="auto">Auto</button>
          <button class="theme-btn" type="button" data-theme-pick="light">Light</button>
          <button class="theme-btn" type="button" data-theme-pick="dark">Dark</button>
        </div>
      </div>
      <div id="page" class="shell"></div>
    </div>
  </div>
</div>

<div id="modal-root"></div>
<div id="toast-root" class="jx-toast-container"></div>
<script src="/admin.js?v=${buildId}"></script>
</body>
</html>`;
}
