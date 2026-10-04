import { pageStyles } from "./styles";
import { pageScript } from "./script";

function decodeUnicodeEscapes(text: string): string {
  const decodedCodePoints = text.replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex: string) => {
    const codePoint = Number.parseInt(hex, 16);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
  });
  return decodedCodePoints.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) ? String.fromCharCode(code) : _;
  });
}

export function htmlPage(): string {
  const html = String.raw`
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kafu</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,500&family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
${pageStyles}
  </style>
</head>
<body>
  <div class="grain" aria-hidden="true"></div>
  <button class="settings-btn" id="settings-btn" type="button">Settings</button>
  <aside class="settings-modal" id="settings-modal" aria-live="polite">
    <div class="settings-head">
      <span>Settings</span>
      <button class="settings-close" id="settings-close" type="button" aria-label="Close settings">×</button>
    </div>
    <div class="settings-stack">
      <div class="setting-item">
        <div class="setting-main">
          <div class="settings-label">🕒 Clock</div>
          <div class="settings-meta" id="clock-info">24-hour format</div>
        </div>
        <button class="hb-toggle" id="clock-toggle" type="button">24h</button>
      </div>
      <div class="setting-item">
        <div class="setting-main">
          <div class="settings-label">🧾 Advanced</div>
          <div class="settings-meta">Technical runtime and JSON files</div>
        </div>
        <button class="hb-toggle on" id="info-open" type="button">Info</button>
      </div>
    </div>
  </aside>
  <section class="info-modal" id="info-modal" aria-live="polite" aria-hidden="true">
    <article class="info-card">
      <div class="info-head">
        <span>Advanced Technical Info</span>
        <button class="settings-close" id="info-close" type="button" aria-label="Close technical info">×</button>
      </div>
      <div class="info-body" id="info-body">
        <div class="info-section">
          <div class="info-title">Loading</div>
          <pre class="info-json">Loading technical data...</pre>
        </div>
      </div>
    </article>
  </section>
  <main class="stage">
    <nav class="tab-nav" role="tablist" aria-label="Main navigation">
      <button class="tab-btn tab-btn-active" id="tab-dashboard" type="button" role="tab" aria-selected="true" aria-controls="dashboard-panel">Dashboard</button>
      <button class="tab-btn" id="tab-chat" type="button" role="tab" aria-selected="false" aria-controls="chat-panel">Chat</button>
      <button class="tab-btn" id="tab-usage" type="button" role="tab" aria-selected="false" aria-controls="usage-panel">Usage</button>
    </nav>
    <div id="dashboard-panel">
    <section class="hero">
      <div class="logo-art" role="img" aria-label="Kafu">
        <div class="logo-top"><span>Kafu</span></div>
      </div>
      <div class="typewriter" id="typewriter" aria-live="polite"></div>
      <div class="time" id="clock">--:--:--</div>
      <div class="date" id="date">Loading date...</div>
      <div class="message" id="message">Welcome back.</div>
    </section>
    </div>
    <div id="usage-panel" hidden>
      <section class="usage-section" id="usage-section">
        <div class="usage-head">
          <div class="usage-title">Session Usage</div>
          <div class="usage-sub">Token consumption and estimated cost per session · refreshes every 60s</div>
        </div>
        <div class="usage-table-wrap" id="usage-table-wrap">
          <div class="usage-loading">Loading usage data...</div>
        </div>
      </section>
    </div>
    <div id="chat-panel" class="chat-panel" hidden>
      <div class="chat-layout">
        <div class="chat-sidebar" id="chat-sidebar">
          <div class="chat-sidebar-header">
            <h3>Sessions</h3>
            <button id="new-session-btn" class="new-session-btn" type="button">+ New</button>
          </div>
          <div id="session-list" class="session-list">
            <div class="session-loading">Loading…</div>
          </div>
        </div>
        <div class="chat-main">
          <div id="chat-history-banner" class="chat-history-banner" hidden>
            Viewing history — new messages go to current session
          </div>
          <div id="load-more-container" class="load-more-container" hidden>
            <button id="load-more-btn" class="load-more-btn" type="button">Load older messages</button>
          </div>
          <div id="chat-messages" class="chat-messages"></div>
          <div class="chat-input-area">
            <form id="chat-form" class="chat-form">
              <input
                type="file"
                id="chat-file-input"
                multiple
                style="display:none"
                accept="text/plain,text/html,text/css,text/javascript,text/typescript,text/x-python,text/csv,text/xml,text/markdown,application/json,application/yaml,application/toml,image/jpeg,image/png,image/gif,image/webp,.js,.ts,.py,.json,.yaml,.yml,.md,.txt,.csv,.xml,.sh,.sql,.toml,.ini,.env,.log"
              />
              <textarea
                id="chat-input"
                class="chat-input"
                placeholder="Message Claude..."
                rows="1"
                autocomplete="off"
              ></textarea>
              <div id="chat-attachments" class="chat-attachments" hidden></div>
              <button id="chat-attach" class="chat-attach" type="button" title="Attach files">📎</button>
              <button id="chat-cancel" class="chat-cancel" type="button" hidden>Cancel</button>
              <button id="chat-send" class="chat-send" type="submit">Send</button>
            </form>
          </div>
        </div><!-- chat-main -->
      </div><!-- chat-layout -->
    </div>
  </main>

  <div class="dock-shell">
    <footer class="dock" id="dock" aria-live="polite">
      <div class="pill">Connecting...</div>
    </footer>
    <aside class="side-bubble" id="uptime-bubble" aria-live="polite">
      <div class="side-icon">⏱️</div>
      <div class="side-value">-</div>
      <div class="side-label">Uptime</div>
    </aside>
  </div>

  <script>
${pageScript}
  </script>
</body>
</html>`;
  return decodeUnicodeEscapes(html);
}
