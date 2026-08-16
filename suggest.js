// suggest.js: the dev-stage change button. Drop it in any of David's apps.
//
// One floating button on every page. Tap it, say what you want changed, keep
// going. The note carries which app and which page you were on, so a later
// session can read a per-app list instead of guessing what "the button is
// wrong" referred to.
//
// Self-contained on purpose: no imports, no build step, no framework. Seven
// apps with seven different module setups (importmaps, app/main.js, plain
// modules) all take a plain <script src="./suggest.js"></script>.
//
// All seven PWAs share the janniksin.github.io origin, so localStorage is
// shared and the Crystal key ("crystal.key") is already there once Crystal has
// been opened. No second login.
//
// Retire it for one app by deleting the script tag. Silence it everywhere for
// a session with localStorage.setItem("suggest.off", "1").
(function () {
  "use strict";

  var WORKER = "https://crystal-brief.janniksin.workers.dev";
  // The app name comes from the folder the page is served under
  // (janniksin.github.io/<app>/), falling back to the document title so a
  // local file:// open still labels itself.
  var APP = (location.pathname.split("/").filter(Boolean)[0] || "local").toLowerCase();
  var QUEUE_KEY = "suggest.queue." + APP;

  if (localStorage.getItem("suggest.off") === "1") return;

  // ---------- storage helpers (never throw: full storage must not break the app)
  function qGet() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function qSet(v) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(v)); return true; }
    catch (e) { return false; }
  }
  function keyOf() { return localStorage.getItem("crystal.key") || ""; }

  // The page you were looking at. Every one of these apps is hash-routed, so
  // the hash IS the page; strip the leading #/ and keep it short.
  function routeNow() {
    var h = (location.hash || "").replace(/^#\/?/, "").split("?")[0];
    return h.slice(0, 80) || "home";
  }

  // ---------- the pipe ----------
  var sending = false;
  function flush() {
    if (sending || !navigator.onLine) return;
    var q = qGet();
    if (!q.length) return;
    var k = keyOf();
    if (!k) return;                        // no key yet; the note waits, never lost
    sending = true;
    var item = q[0];
    fetch(WORKER + "/desk", {
      method: "POST",
      headers: { "content-type": "application/json", "x-brief-key": k },
      body: JSON.stringify(item),
    }).then(function (r) {
      sending = false;
      // /desk is built to return no 4xx but 401, so anything non-401 that is
      // not ok is transient and the note stays queued. 401 also stays queued:
      // the key is wrong, not the note.
      if (r.ok) {
        var q2 = qGet();
        q2.shift();
        qSet(q2);
        paintCount();
        flush();
      }
    }).catch(function () { sending = false; });
  }

  // ---------- UI ----------
  var css =
    ".sg-btn{position:fixed;right:12px;bottom:76px;z-index:2147483000;width:44px;height:44px;" +
    "border-radius:50%;border:1px solid rgba(255,255,255,.28);background:#1b1d24;color:#fff;" +
    "font:600 19px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);" +
    "display:flex;align-items:center;justify-content:center;padding:0}" +
    ".sg-btn:focus-visible{outline:2px solid #7cc4ff;outline-offset:2px}" +
    ".sg-badge{position:absolute;top:-4px;right:-4px;min-width:17px;height:17px;border-radius:9px;" +
    "background:#c2410c;color:#fff;font:600 11px/17px system-ui,sans-serif;text-align:center;padding:0 3px}" +
    ".sg-wrap{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);" +
    "display:flex;align-items:flex-end;justify-content:center}" +
    ".sg-panel{width:100%;max-width:560px;background:#15171d;color:#f2f4f8;border-radius:14px 14px 0 0;" +
    "padding:14px 14px calc(14px + env(safe-area-inset-bottom));" +
    "font:15px/1.45 system-ui,-apple-system,sans-serif;box-shadow:0 -8px 30px rgba(0,0,0,.5)}" +
    ".sg-panel h2{margin:0 0 2px;font-size:15px;font-weight:650}" +
    ".sg-where{margin:0 0 10px;font-size:12.5px;opacity:.62}" +
    ".sg-panel textarea,.sg-panel input{width:100%;box-sizing:border-box;background:#0e1015;" +
    "color:#f2f4f8;border:1px solid #333844;border-radius:9px;padding:10px;font:inherit;resize:vertical}" +
    ".sg-row{display:flex;gap:8px;align-items:center;margin-top:9px}" +
    ".sg-row button{flex:0 0 auto;border-radius:9px;border:1px solid #333844;background:#232733;" +
    "color:#f2f4f8;font:inherit;padding:9px 15px;cursor:pointer}" +
    ".sg-send{background:#2563eb !important;border-color:#2563eb !important;font-weight:600}" +
    ".sg-stat{font-size:12.5px;opacity:.72;margin-left:auto;text-align:right}";

  var style = document.createElement("style");
  style.textContent = css;

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sg-btn";
  btn.setAttribute("aria-label", "Suggest a change to this page");
  btn.title = "Suggest a change";
  btn.appendChild(document.createTextNode("✎"));
  var badge = document.createElement("span");
  badge.className = "sg-badge";
  badge.hidden = true;
  btn.appendChild(badge);

  function paintCount() {
    var n = qGet().length;
    badge.hidden = n === 0;
    badge.textContent = n > 9 ? "9+" : String(n);
  }

  function openPanel() {
    var wrap = document.createElement("div");
    wrap.className = "sg-wrap";
    var panel = document.createElement("div");
    panel.className = "sg-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Suggest a change");

    var h = document.createElement("h2");
    h.textContent = "Change this page";
    var where = document.createElement("p");
    where.className = "sg-where";
    where.textContent = APP + " · " + routeNow();

    var ta = document.createElement("textarea");
    ta.rows = 4;
    ta.placeholder = "what you want different here...";
    ta.setAttribute("aria-label", "What you want changed");

    var row = document.createElement("div");
    row.className = "sg-row";
    var send = document.createElement("button");
    send.type = "button";
    send.className = "sg-send";
    send.textContent = "Send";
    var close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    var stat = document.createElement("span");
    stat.className = "sg-stat";

    // The key is only asked for if this origin has never seen Crystal.
    var keyInput = null;
    if (!keyOf()) {
      keyInput = document.createElement("input");
      keyInput.type = "password";
      keyInput.autocomplete = "current-password";
      keyInput.placeholder = "Crystal key (once per phone)";
      keyInput.setAttribute("aria-label", "Crystal key");
      panel.appendChild(h);
      panel.appendChild(where);
      panel.appendChild(ta);
      panel.appendChild(keyInput);
    } else {
      panel.appendChild(h);
      panel.appendChild(where);
      panel.appendChild(ta);
    }
    row.appendChild(send);
    row.appendChild(close);
    row.appendChild(stat);
    panel.appendChild(row);
    wrap.appendChild(panel);

    function shut() {
      wrap.remove();
      document.removeEventListener("keydown", onEsc);
      btn.focus();
    }
    function onEsc(e) { if (e.key === "Escape") shut(); }
    document.addEventListener("keydown", onEsc);
    wrap.addEventListener("click", function (e) { if (e.target === wrap) shut(); });
    close.addEventListener("click", shut);

    send.addEventListener("click", function () {
      var text = ta.value.trim();
      if (!text) { stat.textContent = "say something first"; return; }
      if (keyInput && keyInput.value.trim()) {
        try { localStorage.setItem("crystal.key", keyInput.value.trim()); } catch (e) {}
      }
      var q = qGet();
      q.push({
        app: APP,
        route: routeNow(),
        text: text,
        at: new Date().toISOString(),
      });
      if (!qSet(q)) { stat.textContent = "NOT saved, storage is full"; return; }
      paintCount();
      ta.value = "";
      stat.textContent = navigator.onLine ? "sent" : "saved, will send";
      flush();
      setTimeout(shut, 650);
    });

    document.body.appendChild(wrap);
    ta.focus();
  }

  btn.addEventListener("click", openPanel);

  function mount() {
    document.head.appendChild(style);
    document.body.appendChild(btn);
    paintCount();
    flush();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.addEventListener("online", flush);
  window.addEventListener("focus", flush);
})();
