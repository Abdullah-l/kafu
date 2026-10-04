export const pageScript = String.raw`    (function() {
      var stored = sessionStorage.getItem("__kafu_tok");
      var fromUrl = new URL(location.href).searchParams.get("token");
      if (fromUrl) {
        stored = fromUrl;
        sessionStorage.setItem("__kafu_tok", stored);
        var clean = new URL(location.href);
        clean.searchParams.delete("token");
        history.replaceState(null, "", clean.toString());
      }
      if (!stored) {
        document.addEventListener("DOMContentLoaded", function() {
          document.body.innerHTML = '<div style="font-family:monospace;padding:2rem;max-width:480px;margin:4rem auto">' +
            '<h2 style="margin-bottom:1rem">Kafu — Auth Required</h2>' +
            '<p style="margin-bottom:1rem">Paste the token from the daemon log to continue.</p>' +
            '<input id="tok-input" type="text" placeholder="Token" style="width:100%;padding:.5rem;margin-bottom:.75rem;font-family:monospace;box-sizing:border-box">' +
            '<button onclick="var t=document.getElementById(\'tok-input\').value.trim();if(t){sessionStorage.setItem(\'__kafu_tok\',t);location.reload();}" ' +
            'style="padding:.5rem 1.25rem;cursor:pointer">Continue</button></div>';
        });
        return;
      }
      var _origFetch = window.fetch.bind(window);
      window.fetch = function(input, init) {
        var url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
        if (typeof url === "string" && url.startsWith("/api/")) {
          init = Object.assign({}, init);
          init.headers = Object.assign({ "Authorization": "Bearer " + stored }, init.headers);
        }
        return _origFetch(input, init);
      };
    })();

    const $ = (id) => document.getElementById(id);

    const clockEl = $("clock");
    const dateEl = $("date");
    const msgEl = $("message");
    const dockEl = $("dock");
    const typewriterEl = $("typewriter");
    const settingsBtn = $("settings-btn");
    const settingsModal = $("settings-modal");
    const settingsClose = $("settings-close");
    const infoOpen = $("info-open");
    const infoModal = $("info-modal");
    const infoClose = $("info-close");
    const infoBody = $("info-body");
    const clockToggle = $("clock-toggle");
    const clockInfoEl = $("clock-info");
    const uptimeBubbleEl = $("uptime-bubble");
    let use12Hour = localStorage.getItem("clock.format") === "12";
    let timezoneOffsetMinutes = 0;

    function clampTimezoneOffsetMinutes(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return 0;
      return Math.max(-720, Math.min(840, Math.round(n)));
    }

    function toOffsetDate(baseDate) {
      const base = baseDate instanceof Date ? baseDate : new Date(baseDate);
      return new Date(base.getTime() + timezoneOffsetMinutes * 60_000);
    }

    function formatOffsetDate(baseDate, options) {
      return new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(toOffsetDate(baseDate));
    }


    function greetingForHour(h) {
      if (h < 5) return "Night mode.";
      if (h < 12) return "Good morning.";
      if (h < 18) return "Good afternoon.";
      if (h < 22) return "Good evening.";
      return "Wind down and ship clean.";
    }

    function isNightHour(hour) {
      return hour < 5 || hour >= 22;
    }

    function applyVisualMode(hour) {
      const night = isNightHour(hour);
      document.body.classList.toggle("night-mode", night);
      document.body.classList.toggle("day-mode", !night);
      document.body.dataset.mode = night ? "night" : "day";
      msgEl.textContent = night ? "Night mode." : greetingForHour(hour);
    }

    const typePhrases = [
      "Ready when you are.",
      "Mention me in Slack or Telegram.",
      "Dependable by name.",
    ];

    function startTypewriter() {
      let phraseIndex = 0;
      let charIndex = 0;
      let deleting = false;

      function step() {
        const phrase = typePhrases[phraseIndex];
        if (!typewriterEl) return;

        if (!deleting) {
          charIndex = Math.min(charIndex + 1, phrase.length);
          typewriterEl.textContent = phrase.slice(0, charIndex);
          if (charIndex === phrase.length) {
            deleting = true;
            setTimeout(step, 1200);
            return;
          }
          setTimeout(step, 46 + Math.floor(Math.random() * 45));
          return;
        }

        charIndex = Math.max(charIndex - 1, 0);
        typewriterEl.textContent = phrase.slice(0, charIndex);
        if (charIndex === 0) {
          deleting = false;
          phraseIndex = (phraseIndex + 1) % typePhrases.length;
          setTimeout(step, 280);
          return;
        }
        setTimeout(step, 26 + Math.floor(Math.random() * 30));
      }

      step();
    }

    function renderClock() {
      const now = new Date();
      const shifted = toOffsetDate(now);
      const rawH = shifted.getUTCHours();
      const hh = use12Hour ? String((rawH % 12) || 12).padStart(2, "0") : String(rawH).padStart(2, "0");
      const mm = String(shifted.getUTCMinutes()).padStart(2, "0");
      const ss = String(shifted.getUTCSeconds()).padStart(2, "0");
      const suffix = use12Hour ? (rawH >= 12 ? " PM" : " AM") : "";
      clockEl.textContent = hh + ":" + mm + ":" + ss + suffix;
      dateEl.textContent = formatOffsetDate(now, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });
      applyVisualMode(rawH);

      clockEl.classList.remove("ms-pulse");
      requestAnimationFrame(() => clockEl.classList.add("ms-pulse"));
    }

    function buildPills(state) {
      const pills = [];

      pills.push({
        cls: state.security.level === "unrestricted" ? "warn" : "ok",
        icon: "🛡️",
        label: "Security",
        value: cap(state.security.level),
      });

      pills.push({
        cls: state.telegram.configured ? "ok" : "warn",
        icon: "✈️",
        label: "Telegram",
        value: state.telegram.configured
          ? (state.telegram.allowedUserCount + " user" + (state.telegram.allowedUserCount !== 1 ? "s" : ""))
          : "Not configured",
      });

      pills.push({
        cls: state.slack && state.slack.configured ? "ok" : "warn",
        icon: "💬",
        label: "Slack",
        value: state.slack && state.slack.configured
          ? (state.slack.allowedUserCount + " user" + (state.slack.allowedUserCount !== 1 ? "s" : ""))
          : "Not configured",
      });

      pills.push({
        cls: "ok",
        icon: "🧠",
        label: "Model",
        value: state.model || "default",
      });

      return pills;
    }

    function fmtDur(ms) {
      if (ms == null) return "n/a";
      const s = Math.floor(ms / 1000);
      const d = Math.floor(s / 86400);
      if (d > 0) {
        const h = Math.floor((s % 86400) / 3600);
        return d + "d " + h + "h";
      }
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = s % 60;
      if (h > 0) return h + "h " + m + "m";
      if (m > 0) return m + "m " + ss + "s";
      return ss + "s";
    }

    async function refreshState() {
      try {
        const res = await fetch("/api/state");
        const state = await res.json();
        const pills = buildPills(state);
        dockEl.innerHTML = pills.map((p) =>
          '<div class="pill ' + p.cls + '">' +
            '<div class="pill-label"><span class="pill-icon">' + esc(p.icon || "") + "</span>" + esc(p.label) + '</div>' +
            '<div class="pill-value">' + esc(p.value) + '</div>' +
          "</div>"
        ).join("");
        if (uptimeBubbleEl) {
          uptimeBubbleEl.innerHTML =
            '<div class="side-icon">⏱️</div>' +
            '<div class="side-value">' + esc(fmtDur(state.daemon?.uptimeMs ?? 0)) + "</div>" +
            '<div class="side-label">Uptime</div>';
        }
      } catch (err) {
        dockEl.innerHTML = '<div class="pill bad"><div class="pill-label"><span class="pill-icon">⚠️</span>Status</div><div class="pill-value">Offline</div></div>';
        if (uptimeBubbleEl) {
          uptimeBubbleEl.innerHTML = '<div class="side-icon">⏱️</div><div class="side-value">-</div><div class="side-label">Uptime</div>';
        }
      }
    }
    function cap(s) {
      if (!s) return "";
      return s.slice(0, 1).toUpperCase() + s.slice(1);
    }

    async function loadSettings() {
      try {
        const res = await fetch("/api/settings");
        const data = await res.json();
        timezoneOffsetMinutes = clampTimezoneOffsetMinutes(data?.timezoneOffsetMinutes);
        renderClock();
      } catch {}
    }

    async function openTechnicalInfo() {
      if (!infoModal || !infoBody) return;
      infoModal.classList.add("open");
      infoModal.setAttribute("aria-hidden", "false");
      infoBody.innerHTML = '<div class="info-section"><div class="info-title">Loading</div><pre class="info-json">Loading technical data...</pre></div>';
      try {
        const res = await fetch("/api/technical-info");
        const data = await res.json();
        renderTechnicalInfo(data);
      } catch (err) {
        infoBody.innerHTML = '<div class="info-section"><div class="info-title">Error</div><pre class="info-json">' + esc(String(err)) + "</pre></div>";
      }
    }

    function renderTechnicalInfo(data) {
      if (!infoBody) return;
      const sections = [
        { title: "daemon", value: data?.daemon ?? null },
        { title: "settings.json", value: data?.files?.settingsJson ?? null },
        { title: "session.json", value: data?.files?.sessionJson ?? null },
        { title: "state.json", value: data?.files?.stateJson ?? null },
      ];
      infoBody.innerHTML = sections.map((section) =>
        '<div class="info-section">' +
          '<div class="info-title">' + esc(section.title) + "</div>" +
          '<pre class="info-json">' + esc(JSON.stringify(section.value, null, 2)) + "</pre>" +
        "</div>"
      ).join("");
    }

    if (settingsBtn && settingsModal) {
      settingsBtn.addEventListener("click", async () => {
        settingsModal.classList.toggle("open");
        if (settingsModal.classList.contains("open")) await loadSettings();
      });
    }

    if (settingsClose && settingsModal) {
      settingsClose.addEventListener("click", () => settingsModal.classList.remove("open"));
    }
    if (infoOpen) {
      infoOpen.addEventListener("click", openTechnicalInfo);
    }
    if (infoClose && infoModal) {
      infoClose.addEventListener("click", () => {
        infoModal.classList.remove("open");
        infoModal.setAttribute("aria-hidden", "true");
      });
    }
    document.addEventListener("click", (event) => {
      if (!settingsModal || !settingsBtn) return;
      if (!settingsModal.classList.contains("open")) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (settingsModal.contains(target) || settingsBtn.contains(target)) return;
      settingsModal.classList.remove("open");
    });
    document.addEventListener("click", (event) => {
      if (!infoModal) return;
      if (!infoModal.classList.contains("open")) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target === infoModal) {
        infoModal.classList.remove("open");
        infoModal.setAttribute("aria-hidden", "true");
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (infoModal && infoModal.classList.contains("open")) {
        infoModal.classList.remove("open");
        infoModal.setAttribute("aria-hidden", "true");
      } else if (settingsModal && settingsModal.classList.contains("open")) {
        settingsModal.classList.remove("open");
      }
    });

    function renderClockToggle() {
      if (!clockToggle) return;
      clockToggle.textContent = use12Hour ? "12h" : "24h";
      clockToggle.className = "hb-toggle " + (use12Hour ? "on" : "off");
      if (clockInfoEl) clockInfoEl.textContent = use12Hour ? "12-hour format" : "24-hour format";
    }

    if (clockToggle) {
      renderClockToggle();
      clockToggle.addEventListener("click", () => {
        use12Hour = !use12Hour;
        localStorage.setItem("clock.format", use12Hour ? "12" : "24");
        renderClockToggle();
        renderClock();
      });
    }

    function esc(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function escAttr(s) {
      return esc(String(s)).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    renderClock();
    setInterval(renderClock, 1000);
    startTypewriter();

    loadSettings();
    refreshState();
    setInterval(refreshState, 1000);

    const tabDashboardBtn = $("tab-dashboard");
    const tabChatBtn = $("tab-chat");
    const tabUsageBtn = $("tab-usage");
    const dashboardPanel = $("dashboard-panel");
    const chatPanel = $("chat-panel");
    const usagePanel = $("usage-panel");
    const chatMessages = $("chat-messages");
    const chatForm = $("chat-form");
    const chatInput = $("chat-input");
    const chatSend = $("chat-send");
    const chatAttachBtn = $("chat-attach");
    const chatFileInput = $("chat-file-input");
    const chatAttachmentsEl = $("chat-attachments");

    var pendingAttachments = [];

    function renderAttachmentChips() {
      if (!chatAttachmentsEl) return;
      if (pendingAttachments.length === 0) {
        chatAttachmentsEl.hidden = true;
        chatAttachmentsEl.innerHTML = "";
        return;
      }
      chatAttachmentsEl.hidden = false;
      chatAttachmentsEl.innerHTML = pendingAttachments.map(function(att, idx) {
        return (
          '<span class="attach-chip">' +
            '<span class="attach-chip-name" title="' + escAttr(att.name) + '">' + esc(att.name) + '</span>' +
            '<button class="attach-chip-remove" type="button" data-attach-index="' + idx + '" aria-label="Remove ' + escAttr(att.name) + '">×</button>' +
          '</span>'
        );
      }).join("");
    }

    function readFileAsBase64(file) {
      return new Promise(function(resolve, reject) {
        var reader = new FileReader();
        reader.onload = function(e) {
          var result = e.target.result;
          var base64 = typeof result === "string" ? result.split(",")[1] || "" : "";
          resolve(base64);
        };
        reader.onerror = function() { reject(new Error("Failed to read file")); };
        reader.readAsDataURL(file);
      });
    }

    if (chatAttachBtn && chatFileInput) {
      chatAttachBtn.addEventListener("click", function() {
        if (chatBusy) return;
        chatFileInput.click();
      });
    }

    if (chatFileInput) {
      chatFileInput.addEventListener("change", async function() {
        var files = chatFileInput.files;
        if (!files || !files.length) return;
        var warnEl = $("chat-attach-warn");
        if (warnEl) warnEl.remove();

        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          if (pendingAttachments.length >= 5) {
            var warn = document.createElement("div");
            warn.id = "chat-attach-warn";
            warn.className = "attach-warn";
            warn.textContent = "Max 5 attachments allowed.";
            if (chatAttachmentsEl && chatAttachmentsEl.parentNode) {
              chatAttachmentsEl.parentNode.insertBefore(warn, chatAttachmentsEl.nextSibling);
            }
            break;
          }
          if (file.size > 10 * 1024 * 1024) {
            var warnSize = document.createElement("div");
            warnSize.id = "chat-attach-warn";
            warnSize.className = "attach-warn";
            warnSize.textContent = '"' + file.name + '" exceeds 10 MB limit.';
            if (chatAttachmentsEl && chatAttachmentsEl.parentNode) {
              chatAttachmentsEl.parentNode.insertBefore(warnSize, chatAttachmentsEl.nextSibling);
            }
            continue;
          }
          try {
            var base64 = await readFileAsBase64(file);
            pendingAttachments.push({ name: file.name, type: file.type || "application/octet-stream", data: base64 });
          } catch (_) {}
        }
        chatFileInput.value = "";
        renderAttachmentChips();
      });
    }

    if (chatAttachmentsEl) {
      chatAttachmentsEl.addEventListener("click", function(event) {
        var target = event.target;
        if (!(target instanceof HTMLElement)) return;
        var btn = target.closest("[data-attach-index]");
        if (!btn || !(btn instanceof HTMLElement)) return;
        var idx = parseInt(btn.getAttribute("data-attach-index") || "-1", 10);
        if (idx >= 0 && idx < pendingAttachments.length) {
          pendingAttachments.splice(idx, 1);
          renderAttachmentChips();
        }
      });
    }

    var CHAT_STORAGE_KEY = "kafu.chat.history";
    let chatBusy = false;
    let chatAbortController = null;
    let chatElapsedTimer = null;
    let chatStartedAt = 0;
    let chatHistory = (function() {
      try {
        var saved = localStorage.getItem(CHAT_STORAGE_KEY);
        return saved ? JSON.parse(saved) : [];
      } catch (_) { return []; }
    })();

    function setActiveTab(tab) {
      const allBtns = [tabDashboardBtn, tabChatBtn, tabUsageBtn];
      const allPanels = [dashboardPanel, chatPanel, usagePanel];
      allBtns.forEach(b => { if (b) { b.classList.remove("tab-btn-active"); b.setAttribute("aria-selected", "false"); } });
      allPanels.forEach(p => { if (p) p.hidden = true; });

      if (tab === "dashboard") {
        tabDashboardBtn && tabDashboardBtn.classList.add("tab-btn-active");
        tabDashboardBtn && tabDashboardBtn.setAttribute("aria-selected", "true");
        if (dashboardPanel) dashboardPanel.hidden = false;
      } else if (tab === "usage") {
        tabUsageBtn && tabUsageBtn.classList.add("tab-btn-active");
        tabUsageBtn && tabUsageBtn.setAttribute("aria-selected", "true");
        if (usagePanel) usagePanel.hidden = false;
        fetchUsage();
      } else {
        tabChatBtn && tabChatBtn.classList.add("tab-btn-active");
        tabChatBtn && tabChatBtn.setAttribute("aria-selected", "true");
        if (chatPanel) chatPanel.hidden = false;
        if (chatInput) chatInput.focus();
      }
    }

    if (tabDashboardBtn) tabDashboardBtn.addEventListener("click", () => setActiveTab("dashboard"));
    if (tabChatBtn) tabChatBtn.addEventListener("click", function() { setActiveTab("chat"); loadSessions(); });
    if (tabUsageBtn) tabUsageBtn.addEventListener("click", function() { setActiveTab("usage"); });

    var activeBrowseSessionId = null;
    var browseOffset = 0;
    var browseTotalCount = 0;
    var BROWSE_PAGE = 10;

    function escapeHtml(text) {
      var d = document.createElement("div");
      d.textContent = text;
      return d.innerHTML;
    }

    function formatSessionTime(isoStr) {
      if (!isoStr) return "";
      try {
        var d = new Date(isoStr);
        var now = new Date();
        if (d.toDateString() === now.toDateString()) {
          return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        }
        return d.toLocaleDateString([], { month: "short", day: "numeric" });
      } catch { return ""; }
    }

    async function loadSessions() {
      var listEl = document.getElementById("session-list");
      if (!listEl) return;
      try {
        var res = await fetch("/api/sessions");
        var sessions = await res.json();
        if (!Array.isArray(sessions) || sessions.length === 0) {
          listEl.innerHTML = '<div class="session-loading">No sessions yet</div>';
          return;
        }
        listEl.innerHTML = "";
        sessions.forEach(function(s) {
          var item = document.createElement("div");
          item.className = "session-item" + (s.id === activeBrowseSessionId ? " active" : "");
          var preview = escapeHtml(s.lastMessage || s.firstMessage || "(empty)");
          var channel = s.channel && s.channel !== "web" ? s.channel : "";
          item.innerHTML =
            '<div class="session-item-header">'
            + '<span class="session-agent">' + escapeHtml(s.agent || "global") + "</span>"
            + (channel ? '<span class="session-channel">' + escapeHtml(channel) + "</span>" : "")
            + "</div>"
            + '<div class="session-preview">' + preview + "</div>"
            + '<div class="session-time">' + formatSessionTime(s.lastUsedAt) + " · " + (s.turnCount || 0) + " turns</div>";
          item.addEventListener("click", function() { browseSession(s.id); });
          listEl.appendChild(item);
        });
      } catch (e) {
        listEl.innerHTML = '<div class="session-loading">Failed to load</div>';
      }
    }

    async function browseSession(sessionId) {
      activeBrowseSessionId = sessionId;
      browseOffset = 0;
      browseTotalCount = 0;

      document.querySelectorAll(".session-item").forEach(function(el) {
        el.classList.toggle("active", el.dataset && el.dataset.sid === sessionId);
      });
      loadSessions();

      var banner = document.getElementById("chat-history-banner");
      if (banner) banner.hidden = false;

      chatHistory = [];
      renderChatHistory();
      await loadBrowseMessages(sessionId, false);
    }

    async function loadBrowseMessages(sessionId, loadMore) {
      var loadMoreContainer = document.getElementById("load-more-container");
      var loadMoreBtn = document.getElementById("load-more-btn");
      if (!loadMore) {
        try {
          var res = await fetch("/api/sessions/" + sessionId + "/messages?limit=" + BROWSE_PAGE + "&offset=-1");
          var data = await res.json();
          var msgs = data.messages;
          if (!Array.isArray(msgs)) return;
          browseTotalCount = typeof data.total === "number" ? data.total : msgs.length;
          browseOffset = Math.max(0, browseTotalCount - BROWSE_PAGE);
          chatHistory = msgs.map(function(m) { return { role: m.role, text: m.text }; });
          renderChatHistory();
          if (loadMoreContainer) loadMoreContainer.hidden = browseOffset <= 0;
          if (loadMoreBtn && browseOffset > 0) loadMoreBtn.textContent = "Load older (" + browseOffset + " more)";
        } catch (e) {}
      } else {
        var newOffset = Math.max(0, browseOffset - BROWSE_PAGE);
        var limit = browseOffset - newOffset;
        if (limit <= 0) return;
        try {
          var res2 = await fetch("/api/sessions/" + sessionId + "/messages?limit=" + limit + "&offset=" + newOffset);
          var data2 = await res2.json();
          var older = data2.messages;
          if (!Array.isArray(older)) return;
          var chatMsgsEl = document.getElementById("chat-messages");
          var scrollHeightBefore = chatMsgsEl ? chatMsgsEl.scrollHeight : 0;
          chatHistory = older.map(function(m) { return { role: m.role, text: m.text }; }).concat(chatHistory);
          browseOffset = newOffset;
          renderChatHistory();
          if (chatMsgsEl) chatMsgsEl.scrollTop = chatMsgsEl.scrollHeight - scrollHeightBefore;
          if (loadMoreContainer) loadMoreContainer.hidden = browseOffset <= 0;
          if (loadMoreBtn && browseOffset > 0) loadMoreBtn.textContent = "Load older (" + browseOffset + " more)";
        } catch (e) {}
      }
    }

    var newSessionBtn = document.getElementById("new-session-btn");
    if (newSessionBtn) {
      newSessionBtn.addEventListener("click", function() {
        activeBrowseSessionId = null;
        chatHistory = [];
        renderChatHistory();
        var banner = document.getElementById("chat-history-banner");
        if (banner) banner.hidden = true;
        var loadMoreContainer = document.getElementById("load-more-container");
        if (loadMoreContainer) loadMoreContainer.hidden = true;
        document.querySelectorAll(".session-item").forEach(function(el) { el.classList.remove("active"); });
        if (chatInput) chatInput.focus();
      });
    }

    var loadMoreBtn = document.getElementById("load-more-btn");
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener("click", function() {
        if (activeBrowseSessionId) loadBrowseMessages(activeBrowseSessionId, true);
      });
    }

    loadSessions();

    renderChatHistory();

    function saveChatHistory() {
      try {
        var toSave = chatHistory.filter(function(m) { return !m.streaming && m.agentStatus !== "running"; });
        localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(toSave));
      } catch (_) {}
    }

    function fmtElapsed(ms) {
      var s = Math.floor(ms / 1000);
      if (s < 60) return s + "s";
      return Math.floor(s / 60) + "m " + (s % 60) + "s";
    }

    function setChatBusy(busy) {
      chatBusy = busy;
      var cancelBtn = $("chat-cancel");
      if (chatSend) chatSend.disabled = busy;
      if (cancelBtn) cancelBtn.hidden = !busy;
      if (chatAttachBtn) chatAttachBtn.disabled = busy;
      if (busy) {
        chatStartedAt = Date.now();
        chatElapsedTimer = setInterval(function() {
          var el = document.querySelector(".chat-msg-elapsed");
          if (el) el.textContent = fmtElapsed(Date.now() - chatStartedAt);
        }, 1000);
      } else {
        if (chatElapsedTimer) { clearInterval(chatElapsedTimer); chatElapsedTimer = null; }
        chatAbortController = null;
      }
    }

    function cancelChat() {
      if (chatAbortController) chatAbortController.abort();
    }

    function createChatEmptyState() {
      var empty = document.createElement("div");
      empty.className = "chat-empty";
      empty.textContent = "Send a message to start chatting with the daemon.";
      return empty;
    }

    function createChatMessageEl() {
      var msgEl = document.createElement("div");
      var roleEl = document.createElement("div");
      roleEl.className = "chat-msg-role";
      var textEl = document.createElement("div");
      textEl.className = "chat-msg-text";
      msgEl.appendChild(roleEl);
      msgEl.appendChild(textEl);
      return msgEl;
    }

    function syncChatMessageEl(msgEl, msg, elapsedMs) {
      if (msg.role === "agent") {
        var agentCls = "chat-msg chat-msg-agent" + (msg.agentStatus === "running" ? " chat-msg-agent-running" : " chat-msg-agent-done");
        if (msgEl.className !== agentCls) msgEl.className = agentCls;
        var agentPlainText = msg.text || "";
        var existingSpinner = msgEl.querySelector(".chat-agent-spinner");
        if (msgEl.dataset.agentText !== agentPlainText || msgEl.dataset.agentStatus !== msg.agentStatus) {
          msgEl.textContent = agentPlainText;
          msgEl.dataset.agentText = agentPlainText;
          msgEl.dataset.agentStatus = msg.agentStatus || "";
          if (msg.agentStatus === "running") {
            var spinner = document.createElement("span");
            spinner.className = "chat-agent-spinner";
            spinner.textContent = "…";
            msgEl.appendChild(spinner);
          }
        }
        return;
      }

      var roleEl = msgEl.querySelector(".chat-msg-role");
      var textEl = msgEl.querySelector(".chat-msg-text");
      if (!roleEl || !textEl) {
        msgEl.textContent = "";
        roleEl = document.createElement("div");
        roleEl.className = "chat-msg-role";
        textEl = document.createElement("div");
        textEl.className = "chat-msg-text";
        msgEl.appendChild(roleEl);
        msgEl.appendChild(textEl);
      }

      var cls = "chat-msg " + (msg.role === "user" ? "chat-msg-user" : "chat-msg-assistant");
      if (msg.streaming) cls += " chat-msg-streaming";
      msgEl.className = cls;
      roleEl.textContent = msg.role === "user" ? "You" : "Claude";
      textEl.textContent = msg.text || "";

      var metaEl = msgEl.querySelector(".chat-msg-elapsed, .chat-msg-background");
      if (msg.streaming && chatBusy) {
        if (!metaEl || !metaEl.classList.contains("chat-msg-elapsed")) {
          if (metaEl) metaEl.remove();
          metaEl = document.createElement("div");
          metaEl.className = "chat-msg-elapsed";
          msgEl.appendChild(metaEl);
        }
        metaEl.textContent = fmtElapsed(elapsedMs);
      } else if (msg.background) {
        if (!metaEl || !metaEl.classList.contains("chat-msg-background")) {
          if (metaEl) metaEl.remove();
          metaEl = document.createElement("div");
          metaEl.className = "chat-msg-background";
          msgEl.appendChild(metaEl);
        }
        metaEl.textContent = "⚙ working in background...";
      } else if (metaEl) {
        metaEl.remove();
      }
    }

    function renderChatHistory() {
      if (!chatMessages) return;
      if (!chatHistory.length) {
        if (
          chatMessages.children.length !== 1 ||
          !chatMessages.firstElementChild ||
          !chatMessages.firstElementChild.classList.contains("chat-empty")
        ) {
          chatMessages.textContent = "";
          chatMessages.appendChild(createChatEmptyState());
        }
        return;
      }

      if (chatMessages.firstElementChild && chatMessages.firstElementChild.classList.contains("chat-empty")) {
        chatMessages.textContent = "";
      }

      var elapsedMs = Date.now() - chatStartedAt;

      for (var i = 0; i < chatHistory.length; i++) {
        var msgEl = chatMessages.children[i];
        if (!msgEl || !msgEl.classList.contains("chat-msg")) {
          msgEl = createChatMessageEl();
          if (i >= chatMessages.children.length) {
            chatMessages.appendChild(msgEl);
          } else {
            chatMessages.insertBefore(msgEl, chatMessages.children[i]);
          }
        }
        syncChatMessageEl(msgEl, chatHistory[i], elapsedMs);
      }

      while (chatMessages.children.length > chatHistory.length) {
        chatMessages.removeChild(chatMessages.lastElementChild);
      }

      chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function autoResizeChatInput() {
      if (!chatInput) return;
      chatInput.style.height = "auto";
      chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + "px";
    }

    async function sendChat() {
      if (chatBusy || !chatInput) return;
      var message = (chatInput.value || "").trim();
      var attachmentsToSend = pendingAttachments.slice();
      if (!message && attachmentsToSend.length === 0) return;

      chatInput.value = "";
      autoResizeChatInput();

      pendingAttachments = [];
      renderAttachmentChips();

      setChatBusy(true);

      var userText = message || ("(" + attachmentsToSend.length + " attachment" + (attachmentsToSend.length !== 1 ? "s" : "") + ")");
      chatHistory.push({ role: "user", text: userText });
      var assistantIdx = chatHistory.length;
      chatHistory.push({ role: "assistant", text: "", streaming: true });
      renderChatHistory();

      chatAbortController = new AbortController();

      try {
        var res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: message, attachments: attachmentsToSend }),
          signal: chatAbortController.signal,
        });

        if (!res.body) throw new Error("No response body");

        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = "";

        while (true) {
          var read = await reader.read();
          if (read.done) break;
          buf += dec.decode(read.value, { stream: true });
          var lines = buf.split("\n");
          buf = lines.pop() || "";
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line.startsWith("data: ")) continue;
            try {
              var ev = JSON.parse(line.slice(6));
              if (ev.type === "chunk") {
                chatHistory[assistantIdx].text += ev.text;
                renderChatHistory();
              } else if (ev.type === "unblock") {
                setChatBusy(false);
                chatHistory[assistantIdx].background = true;
                renderChatHistory();
              } else if (ev.type === "agent_spawn") {
                chatHistory.push({ role: "agent", agentId: ev.id, text: "🤖 Sub-agent started: " + ev.description, agentStatus: "running" });
                renderChatHistory();
              } else if (ev.type === "agent_done") {
                var agentBubble = null;
                for (var k = chatHistory.length - 1; k >= 0; k--) {
                  if (chatHistory[k].role === "agent" && chatHistory[k].agentId === ev.id) {
                    agentBubble = chatHistory[k];
                    break;
                  }
                }
                if (agentBubble) {
                  agentBubble.agentStatus = "done";
                  agentBubble.text = "✅ Sub-agent done: " + ev.description;
                } else {
                  chatHistory.push({ role: "agent", agentId: ev.id, text: "✅ Sub-agent done: " + ev.description, agentStatus: "done" });
                }
                renderChatHistory();
                saveChatHistory();
              } else if (ev.type === "done") {
                chatHistory[assistantIdx].streaming = false;
                chatHistory[assistantIdx].background = false;
                renderChatHistory();
                saveChatHistory();
              } else if (ev.type === "error") {
                chatHistory[assistantIdx].text = chatHistory[assistantIdx].text
                  ? chatHistory[assistantIdx].text + "\n\n[Error: " + ev.message + "]"
                  : "[Error: " + ev.message + "]";
                chatHistory[assistantIdx].streaming = false;
                chatHistory[assistantIdx].background = false;
                renderChatHistory();
                saveChatHistory();
              }
            } catch (_) {}
          }
        }
        chatHistory[assistantIdx].streaming = false;
        renderChatHistory();
        saveChatHistory();
      } catch (err) {
        var cancelled = err && err.name === "AbortError";
        chatHistory[assistantIdx].text = cancelled
          ? (chatHistory[assistantIdx].text || "[Cancelled]")
          : "[Failed: " + String(err) + "]";
        chatHistory[assistantIdx].streaming = false;
        renderChatHistory();
        saveChatHistory();
      } finally {
        setChatBusy(false);
        if (chatInput) chatInput.focus();
      }
    }

    if (chatForm) {
      chatForm.addEventListener("submit", function(e) {
        e.preventDefault();
        sendChat();
      });
    }

    if (chatInput) {
      chatInput.addEventListener("input", autoResizeChatInput);
      chatInput.addEventListener("keydown", function(e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendChat();
        }
      });
    }

    var chatCancelBtn = $("chat-cancel");
    if (chatCancelBtn) {
      chatCancelBtn.addEventListener("click", cancelChat);
    }

    setInterval(function() {
      if (chatBusy && chatMessages) {
        var elapsedEl = chatMessages.querySelector(".chat-msg-elapsed");
        if (elapsedEl) elapsedEl.textContent = fmtElapsed(Date.now() - chatStartedAt);
      }
    }, 1000);

    var usageWrap = $("usage-table-wrap");

    function fmtTokens(n) {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
      if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
      return String(n);
    }

    function fmtCost(usd) {
      if (usd <= 0) return "$0.00";
      if (usd < 0.01) return "<$0.01";
      return "$" + usd.toFixed(2);
    }

    function fmtRelative(iso) {
      if (!iso) return "—";
      var delta = Date.now() - new Date(iso).getTime();
      var s = Math.floor(delta / 1000);
      if (s < 60) return s + "s ago";
      var m = Math.floor(s / 60);
      if (m < 60) return m + "m ago";
      var h = Math.floor(m / 60);
      if (h < 24) return h + "h ago";
      return Math.floor(h / 24) + "d ago";
    }

    function renderUsageTable(sessions) {
      if (!usageWrap) return;
      if (!sessions || sessions.length === 0) {
        usageWrap.innerHTML = '<div class="usage-loading">No active sessions found.</div>';
        return;
      }
      var maxCost = sessions.reduce(function(m, s) { return Math.max(m, s.estimatedCostUsd); }, 0);
      var rows = sessions.map(function(s) {
        var barPct = maxCost > 0 ? Math.round((s.estimatedCostUsd / maxCost) * 100) : 0;
        var channelIcon = s.channel === "slack" ? "💬" : s.channel === "telegram" ? "✈️" : s.channel === "web" ? "🌐" : "❓";
        return "<tr>" +
          "<td class='usage-td usage-td-label'>" + channelIcon + " " + esc(s.label) + "</td>" +
          "<td class='usage-td usage-td-num'>" + fmtTokens(s.inputTokens) + "</td>" +
          "<td class='usage-td usage-td-num'>" + fmtTokens(s.outputTokens) + "</td>" +
          "<td class='usage-td usage-td-num'>" + fmtTokens(s.cacheReadTokens) + "</td>" +
          "<td class='usage-td usage-td-num'>" + s.cacheHitPct + "%</td>" +
          "<td class='usage-td usage-td-cost'>" +
            "<div class='usage-cost-wrap'>" +
              "<div class='usage-cost-bar' style='width:" + barPct + "%'></div>" +
              "<span class='usage-cost-label'>~" + fmtCost(s.estimatedCostUsd) + "</span>" +
            "</div>" +
          "</td>" +
          "<td class='usage-td usage-td-num usage-td-turns'>" + s.turnCount + "</td>" +
          "<td class='usage-td usage-td-age'>" + fmtRelative(s.lastUsedAt) + "</td>" +
          "</tr>";
      }).join("");
      usageWrap.innerHTML =
        "<table class='usage-table'>" +
        "<thead><tr>" +
        "<th class='usage-th'>Session</th>" +
        "<th class='usage-th usage-th-num'>Input</th>" +
        "<th class='usage-th usage-th-num'>Output</th>" +
        "<th class='usage-th usage-th-num'>Cache Read</th>" +
        "<th class='usage-th usage-th-num'>Cache Hit</th>" +
        "<th class='usage-th'>Est. Cost</th>" +
        "<th class='usage-th usage-th-num'>Turns</th>" +
        "<th class='usage-th'>Last Active</th>" +
        "</tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
        "</table>";
    }

    function fetchUsage() {
      fetch("/api/usage")
        .then(function(r) { return r.json(); })
        .then(function(data) { renderUsageTable(Array.isArray(data) ? data : []); })
        .catch(function() {
          if (usageWrap) usageWrap.innerHTML = '<div class="usage-loading">Failed to load usage data.</div>';
        });
    }

    fetchUsage();
    setInterval(fetchUsage, 60_000);`;
