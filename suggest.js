// suggest.js: the dev-stage change button. Drop it in any of David's apps.
//
// One floating button on every page. Tap it, say what you want changed, keep
// going. The note carries which app and which page you were on, so a later
// session can read a per-app list instead of guessing what "the button is
// wrong" referred to.
//
// Self-contained on purpose: no imports, no build step, no framework. Eight
// apps with eight different module setups (importmaps, app/main.js, plain
// modules) all take a plain <script src="./suggest.js"></script>.
//
// No key, no login, nothing to paste (David, 2026-08-26). The Worker accepts a
// keyless POST on the two Desk write routes, so a note or a recording sends the
// moment he taps Send. If a Crystal key happens to already be in localStorage
// it rides along as provenance; it is never required and never asked for.
//
// The mic is here on purpose: most of these notes are spoken while walking, so
// every app gets the recorder, not just the ones that grew one.
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
  // Optional. Present on David's own phone because Crystal shares this origin;
  // absent everywhere else and that is fine. Never gate on it.
  function keyOf() { return localStorage.getItem("crystal.key") || ""; }
  function authHeaders(base) {
    var k = keyOf();
    if (k) base["x-brief-key"] = k;
    return base;
  }

  // The page you were looking at. Every one of these apps is hash-routed, so
  // the hash IS the page; strip the leading #/ and keep it short.
  function routeNow() {
    var h = (location.hash || "").replace(/^#\/?/, "").split("?")[0];
    return h.slice(0, 80) || "home";
  }

  // ---------- the audio queue ----------
  // Voice notes must work on a train: blobs are too big for localStorage, so
  // they queue in their own tiny IndexedDB store and flush exactly like the
  // text queue when signal returns. A 4xx (not 401) means the Worker refused
  // these bytes forever; drop them rather than retry a poisoned blob.
  function adb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open("suggest-audio", 1);
      r.onupgradeneeded = function () {
        r.result.createObjectStore("blobs", { keyPath: "id", autoIncrement: true });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function atx(mode, fn) {
    return adb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction("blobs", mode);
        var out = fn(t.objectStore("blobs"));
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }
  function aAdd(rec) { return atx("readwrite", function (s) { return s.add(rec); }); }
  function aAll() {
    return atx("readonly", function (s) { return s.getAll(); })
      .then(function (v) { return v || []; })
      .catch(function () { return []; });
  }
  function aDel(id) { return atx("readwrite", function (s) { return s.delete(id); }); }

  var aSending = false;
  function aFlush() {
    if (aSending || !navigator.onLine) return;
    aAll().then(function (all) {
      if (!all.length) return;
      aSending = true;
      var item = all[0];
      fetch(WORKER + "/deskaudio?app=" + encodeURIComponent(item.app)
          + "&route=" + encodeURIComponent(item.route), {
        method: "POST",
        headers: authHeaders({ "content-type": item.type || "audio/mp4" }),
        body: item.blob,
      }).then(function (r) {
        aSending = false;
        // 401 still means retry: the send is keyless now, so a 401 is the
        // Worker being mid-deploy, not these bytes being unwelcome.
        if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 401)) {
          aDel(item.id).then(function () { paintCount(); aFlush(); });
        }
      }).catch(function () { aSending = false; });
    });
  }

  // ---------- the pipe ----------
  var sending = false;
  function flush() {
    if (sending || !navigator.onLine) return;
    var q = qGet();
    if (!q.length) return;
    sending = true;
    var item = q[0];
    fetch(WORKER + "/desk", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(item),
    }).then(function (r) {
      sending = false;
      // /desk is built to return no 4xx but 401, so anything that is not ok is
      // transient and the note stays queued. Nothing is ever dropped.
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
  // The sheet is a linked same-origin file (see suggest.css). A <style> element
  // injected from script is blocked by these apps' style-src 'self', so the
  // button rendered unstyled everywhere until this moved out of the script.
  var SELF = document.currentScript && document.currentScript.src;
  var style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = new URL("suggest.css", SELF || location.href).href;

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
    // the badge counts everything still waiting to send, spoken included
    aAll().then(function (a) {
      var n = qGet().length + a.length;
      badge.hidden = n === 0;
      badge.textContent = n > 9 ? "9+" : String(n);
    });
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

    // The mic: same recorder pattern as Crystal's bubble, posting straight to
    // /deskaudio with this app + page attached, so the drain's faster-whisper
    // transcript files against this app like a typed note. Online-only on
    // purpose: an audio blob is too big for the localStorage queue, and a
    // failed send says so instead of pretending.
    var mic = document.createElement("button");
    mic.type = "button";
    mic.className = "sg-mic";
    mic.textContent = "🎙";
    mic.setAttribute("aria-label", "Record the change out loud");
    var rec = null;
    var chunks = [];
    var acquiring = false;
    var cancelled = false;   // shut() mid-recording means cancel, never send
    mic.addEventListener("click", function () {
      if (rec && rec.state === "recording") { rec.stop(); return; }
      if (acquiring) return;
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        stat.textContent = "this browser cannot record; type it";
        return;
      }
      acquiring = true;
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        acquiring = false;
        var mime = MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "audio/webm";
        rec = new MediaRecorder(stream, { mimeType: mime });
        chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          mic.textContent = "🎙";
          if (cancelled) return;
          var blob = new Blob(chunks, { type: (chunks[0] && chunks[0].type) || mime });
          // queue first, send second: a train tunnel between stop and send
          // must not eat the take
          aAdd({ app: APP, route: routeNow(), type: blob.type, blob: blob, at: new Date().toISOString() })
            .then(function () {
              paintCount();
              stat.textContent = navigator.onLine
                ? "recorded; transcribes within the hour"
                : "recorded; sends when signal returns";
              aFlush();
            })
            .catch(function () {
              stat.textContent = "this phone would not store the recording";
            });
        };
        rec.start(5000);
        setTimeout(function () { if (rec && rec.state === "recording") rec.stop(); }, 180000);
        mic.textContent = "⏹";
        stat.textContent = "recording... tap to stop";
      }).catch(function () {
        acquiring = false;
        stat.textContent = "mic unavailable; type it instead";
      });
    });

    var send = document.createElement("button");
    send.type = "button";
    send.className = "sg-send";
    send.textContent = "Send";
    var close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close";
    var stat = document.createElement("span");
    stat.className = "sg-stat";

    panel.appendChild(h);
    panel.appendChild(where);
    panel.appendChild(ta);
    row.appendChild(mic);
    row.appendChild(send);
    row.appendChild(close);
    row.appendChild(stat);
    panel.appendChild(row);
    wrap.appendChild(panel);

    function shut() {
      // closing mid-recording releases the mic AND drops the take: a closed
      // panel means cancel, so onstop must not upload it
      if (rec && rec.state === "recording") { cancelled = true; rec.stop(); }
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
    aFlush();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.addEventListener("online", function () { flush(); aFlush(); });
  window.addEventListener("focus", function () { flush(); aFlush(); });
})();
