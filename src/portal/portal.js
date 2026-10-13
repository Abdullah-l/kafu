(function () {
  var LINK = /(https?:\/\/[^\s<>"'`]+|\b(?:[a-z0-9-]+\.)+(?:com|io|net|org|dev|app|ai|sa|co)\b(?:\/[^\s<>"'`]*)?)/gi;

  function api(path, body) {
    var opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "x-kafu": "1" }, body: JSON.stringify(body) };
    return fetch(path, opts).then(function (r) {
      return r.json().then(function (data) {
        if (r.status === 401) { showExpired(); throw new Error("expired"); }
        return data;
      });
    });
  }

  function showExpired() {
    var main = document.querySelector("main");
    main.innerHTML = "";
    main.className = "expired";
    main.appendChild(el("h1", { text: "Your session expired" }));
    main.appendChild(el("p", { class: "help", text: "Ask for a new link in Slack: mention the bot with connect." }));
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") node.textContent = attrs[k];
      else if (k === "onclick") node.addEventListener("click", attrs[k]);
      else if (k === "oninput") node.addEventListener("input", attrs[k]);
      else if (k === "onenter") node.addEventListener("keydown", function (e) { if (e.key === "Enter") attrs[k](e); });
      else if (k === "value") node.value = attrs[k];
      else if (attrs[k] === null || attrs[k] === undefined) return;
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return node;
  }

  function anchor(href, text, cls) {
    return el("a", { class: cls || "inline-link", href: href, target: "_blank", rel: "noopener noreferrer", text: text });
  }

  function linkify(text) {
    var frag = document.createDocumentFragment();
    var last = 0;
    text.replace(LINK, function (match, _g, offset) {
      var url = match.replace(/[.,;:!?)\]]+$/, "");
      if (offset > last) frag.appendChild(document.createTextNode(text.slice(last, offset)));
      var href = /^https?:\/\//i.test(url) ? url : "https://" + url;
      frag.appendChild(anchor(href, url.replace(/^https?:\/\//i, "")));
      last = offset + url.length;
      return match;
    });
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function helpText(text) {
    var node = el("div", { class: "help" });
    node.appendChild(linkify(text));
    return node;
  }

  function copyText(text, button) {
    var done = function () { if (button) { button.textContent = "Copied"; setTimeout(function () { button.textContent = "Copy code"; }, 1500); } };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(area);
  }

  window.Portal = { api: api, el: el, anchor: anchor, linkify: linkify, helpText: helpText, copyText: copyText, showExpired: showExpired };
})();
