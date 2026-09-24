export const ADMIN_CSS = `.hidden { display: none !important; }

.jx-login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.jx-login-card { width: 400px; max-width: calc(100vw - 40px); }

.jx-table { display: flex; flex-direction: column; }

.jx-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
}

.jx-row:last-child { border-bottom: none; }

.jx-row:hover { background: var(--panel-hover); }

.jx-grow { flex: 1; min-width: 0; }

.jx-actions { display: flex; gap: 6px; flex-shrink: 0; align-items: center; }

.jx-sub { font-family: var(--font-mono); font-size: 0.68rem; color: var(--text-muted); overflow-wrap: anywhere; }

.jx-group-title {
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 14px 20px 6px;
}

.card-body.tight > .toggle-row { margin: 0 20px; padding: 10px 0; }

.jx-pad { padding: 14px 20px; display: flex; flex-direction: column; gap: 12px; }

.jx-error { font-family: var(--font-mono); font-size: 0.75rem; color: var(--error); padding: 12px 20px; }

.jx-note { font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted); }

@media (max-width: 640px) {
  .jx-row { flex-wrap: wrap; }
  .jx-actions { flex-wrap: wrap; }
}

.profile-avatar-circle {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 0.8rem;
  color: #ffffff;
  flex-shrink: 0;
  text-shadow: 0 1px 2px rgba(0,0,0,0.3);
}

.profile-avatar-img {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  border: 1px solid var(--border);
}

.addon-under-profile { padding-left: 44px; }

.nuvio-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
}

.nuvio-status-connected {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
  border: 1px solid rgba(34, 197, 94, 0.3);
}

.nuvio-status-disconnected {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.jx-toast-container {
  position: fixed;
  bottom: 24px;
  right: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 9999;
  pointer-events: none;
}
.jx-toast {
  pointer-events: auto;
  padding: 10px 18px;
  border-radius: var(--radius-md);
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-md);
  transition: opacity 0.25s ease, transform 0.25s ease;
  animation: jxToastIn 0.2s ease-out;
}
@keyframes jxToastIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
.jx-toast-fade {
  opacity: 0;
  transform: translateY(10px);
}
.jx-toast-success { border-left: 4px solid var(--success); }
.jx-toast-error { border-left: 4px solid var(--error); }
.jx-toast-info { border-left: 4px solid var(--primary); }

.qc-container {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 520px;
}
.qc-input-row {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.qc-code-input {
  font-family: var(--font-mono);
  font-size: 1.4rem;
  font-weight: 700;
  letter-spacing: 0.25em;
  text-align: center;
  width: 170px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  border: 2px solid var(--border);
  background: var(--panel);
  color: var(--text);
  text-transform: uppercase;
}
.qc-code-input:focus {
  border-color: var(--primary);
  outline: none;
  box-shadow: 0 0 0 3px var(--primary-glow);
}
.qc-feedback {
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
  font-weight: 500;
  display: none;
}
.qc-feedback.show { display: block; }
.qc-feedback-success {
  background: rgba(0, 179, 84, 0.12);
  border: 1px solid rgba(0, 179, 84, 0.3);
  color: var(--success);
}
.qc-feedback-error {
  background: rgba(231, 76, 60, 0.12);
  border: 1px solid rgba(231, 76, 60, 0.3);
  color: var(--error);
}

.addon-item-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  margin-bottom: 8px;
  transition: background 0.15s ease;
}
.addon-item-bar:hover {
  background: var(--panel-hover);
}
.addon-drag-handle {
  cursor: grab;
  color: var(--text-dim);
  font-size: 1.1rem;
  user-select: none;
  padding: 0 4px;
}
.addon-health-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 0.68rem;
  font-weight: 600;
  font-family: var(--font-mono);
}
.addon-health-ok {
  background: rgba(0, 179, 84, 0.12);
  color: var(--success);
  border: 1px solid rgba(0, 179, 84, 0.25);
}
.addon-health-fail {
  background: rgba(231, 76, 60, 0.12);
  color: var(--error);
  border: 1px solid rgba(231, 76, 60, 0.25);
}
.addon-latency-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 0.68rem;
  font-weight: 500;
  font-family: var(--font-mono);
  background: rgba(148, 163, 184, 0.12);
  color: var(--text-dim);
  border: 1px solid rgba(148, 163, 184, 0.25);
}
.addon-resource-tag {
  font-size: 0.65rem;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--primary-dim);
  color: var(--primary);
  border: 1px solid var(--primary-glow);
  font-family: var(--font-mono);
  text-transform: capitalize;
}

.sub-filter-tabs {
  display: flex;
  gap: 4px;
  background: var(--bg-secondary);
  padding: 3px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}
.sub-filter-btn {
  padding: 4px 12px;
  font-size: 0.75rem;
  font-weight: 600;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.sub-filter-btn.active {
  background: var(--primary);
  color: #ffffff;
}
.sub-fail-reason {
  color: var(--error);
  font-weight: 600;
}
`;
