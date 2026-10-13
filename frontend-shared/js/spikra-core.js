/* Spikra shared frontend core: safe DOM helpers, API client, Zoho WorkDrive connection and file picker.
 * Used by both Slate apps. Requires window.SPIKRA_CONFIG = { apiBase } (see each app's config.js).
 * Never writes server-provided text with innerHTML - everything goes through el()/textContent. */
(function (global) {
  "use strict";

  var cfg = global.SPIKRA_CONFIG || {};
  var API_BASE = String(cfg.apiBase || "").replace(/\/+$/, "");
  var API_ORIGIN = "";
  try { API_ORIGIN = new URL(API_BASE).origin; } catch (e) { /* surfaced by assertConfigured() */ }

  var S = { config: cfg };

  S.assertConfigured = function () {
    if (!API_ORIGIN) throw new Error("This app is not configured: config.js must set SPIKRA_CONFIG.apiBase.");
  };

  /* ---------- DOM helpers ---------- */
  function appendKids(node, kids) {
    kids.forEach(function (kid) {
      if (kid === null || kid === undefined || kid === false) return;
      if (Array.isArray(kid)) return appendKids(node, kid);
      node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    });
  }

  S.el = function (tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key === "dataset") Object.keys(value).forEach(function (d) { node.dataset[d] = value[d]; });
      else if (key.slice(0, 2) === "on" && typeof value === "function") node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, "");
      else node.setAttribute(key, value);
    });
    appendKids(node, Array.prototype.slice.call(arguments, 2));
    return node;
  };
  var el = S.el;

  S.clear = function (node) { while (node.firstChild) node.removeChild(node.firstChild); return node; };
  S.mount = function (node, kids) { S.clear(node); appendKids(node, [].concat(kids)); return node; };

  S.toast = function (message, kind, ms) {
    var host = document.getElementById("sp-toasts");
    if (!host) { host = el("div", { id: "sp-toasts", class: "sp-toasts", role: "status", "aria-live": "polite" }); document.body.appendChild(host); }
    var toast = el("div", { class: "sp-toast" + (kind ? " " + kind : "") }, String(message));
    host.appendChild(toast);
    setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, ms || 4500);
  };

  S.fmtBytes = function (n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  };

  S.parseDate = function (raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(:\d{3})?$/.test(s)) s = s.replace(" ", "T").replace(/:(\d{3})$/, ".$1");
    var d = new Date(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : s + "Z");
    return isNaN(d.getTime()) ? null : d;
  };

  S.fmtDate = function (raw) {
    var d = S.parseDate(raw);
    if (!d) return "";
    var diff = Date.now() - d.getTime();
    if (diff >= 0 && diff < 60000) return "just now";
    if (diff >= 0 && diff < 3600000) return Math.floor(diff / 60000) + " min ago";
    if (diff >= 0 && diff < 86400000) return Math.floor(diff / 3600000) + " h ago";
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  };

  S.copyText = function (text) {
    var done = function () { S.toast("Link copied to clipboard", "ok"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(done, function () { S.toast("Copy failed - select the link manually.", "err"); });
    }
    var ta = el("textarea", { style: "position:fixed;opacity:0" });
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { S.toast("Copy failed - select the link manually.", "err"); }
    document.body.removeChild(ta);
  };

  S.sleep = function (ms, signal) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener("abort", function () { clearTimeout(t); reject(new ApiError(0, "ABORTED", "Cancelled.")); });
    });
  };

  S.extOf = function (name) {
    var m = /\.[^./\\]+$/.exec(String(name || ""));
    return m ? m[0].toLowerCase() : "";
  };

  /* ---------- API client ---------- */
  function ApiError(status, code, message) {
    var err = new Error(message);
    err.name = "ApiError"; err.status = status; err.code = code;
    return err;
  }
  S.ApiError = ApiError;

  S.api = function (path, opts) {
    S.assertConfigured();
    opts = opts || {};
    var url = API_BASE + path;
    if (opts.query) {
      var qs = new URLSearchParams();
      Object.keys(opts.query).forEach(function (k) {
        var v = opts.query[k];
        if (v !== null && v !== undefined && v !== "") qs.set(k, v);
      });
      var s = qs.toString();
      if (s) url += (url.indexOf("?") >= 0 ? "&" : "?") + s;
    }

    var headers = { Accept: "application/json" };
    var token = S.auth.token();
    if (opts.auth !== false && token) headers.Authorization = "Bearer " + token;
    else if (opts.auth === true) return Promise.reject(ApiError(401, "UNAUTHENTICATED", "Sign in to continue."));
    var body;
    if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.json); }
    else if (opts.body !== undefined) body = opts.body;

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, opts.timeoutMs || 60000);
    if (opts.signal) opts.signal.addEventListener("abort", function () { controller.abort(); });

    return fetch(url, { method: opts.method || "GET", headers: headers, body: body, signal: controller.signal, credentials: "omit" })
      .catch(function (e) {
        throw ApiError(0, "NETWORK", e && e.name === "AbortError" ? "The request timed out." : "Could not reach the server. Check your connection and try again.");
      })
      .then(function (res) {
        clearTimeout(timer);
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          var failed = !res.ok || (data && data.success === false);
          if (!failed) return data || {};
          var detail = data && ((data.error && data.error.message) || (typeof data.error === "string" ? data.error : "") || data.error_message);
          var message = detail || (data && data.message) || ("The request failed (HTTP " + res.status + ").");
          var code = (data && ((data.error && data.error.code) || data.error_code)) || "REQUEST_FAILED";
          if (res.status === 401 && opts.auth !== false) S.auth.expire();
          if (code === "WORKDRIVE_NOT_CONNECTED" || code === "WORKDRIVE_TOKEN_EXPIRED") S.workdrive.markDisconnected();
          throw ApiError(res.status, code, message);
        });
      }, function (e) { clearTimeout(timer); throw e; });
  };

  /* ---------- App sign-in (Zoho) ---------- */
  var TOKEN_KEY = "spikra.session";
  var BINDING_KEY = "spikra.wd.binding";
  var LOGIN_ERRORS = {
    access_denied: "Sign-in was cancelled.",
    not_allowed: "That Zoho account is not allowed to use this app. Sign in with your Spikra account.",
    disabled: "This account has been disabled. Contact an administrator.",
    login_failed: "Sign-in failed. Please try again."
  };

  function storage(op, key, value) {
    try {
      if (op === "get") return sessionStorage.getItem(key);
      if (op === "set") sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch (e) { /* storage unavailable: the session lasts for this page view only */ }
    return null;
  }

  var auth = { state: { status: "loading", user: null, error: null }, tok: null, listeners: [] };
  var wd = { state: { connected: false, email: null, busy: false }, listeners: [] };
  S.auth = auth;
  S.workdrive = wd;

  function emitAuth() { auth.listeners.forEach(function (fn) { try { fn(auth.state); } catch (e) { console.error(e); } }); }
  function emitWd() { wd.listeners.forEach(function (fn) { try { fn(wd.state); } catch (e) { console.error(e); } }); }
  function setWd(patch) { Object.keys(patch).forEach(function (k) { wd.state[k] = patch[k]; }); emitWd(); }

  auth.token = function () { return auth.tok; };
  auth.onChange = function (fn) { auth.listeners.push(fn); fn(auth.state); };

  auth.expire = function (message) {
    if (auth.state.status === "anonymous") return;
    auth.tok = null; storage("remove", TOKEN_KEY);
    auth.state = { status: "anonymous", user: null, error: message || "Your session ended. Please sign in again." };
    setWd({ connected: false, email: null });
    emitAuth();
  };

  auth.login = function () {
    S.assertConfigured();
    window.location.assign(API_BASE + "/auth/login?return_to=" + encodeURIComponent(window.location.origin));
  };

  auth.logout = function () {
    return S.api("/auth/logout", { method: "POST", timeoutMs: 15000 })
      .catch(function () { /* the local session is dropped either way */ })
      .then(function () { auth.tok = null; storage("remove", TOKEN_KEY); storage("remove", BINDING_KEY);
        auth.state = { status: "anonymous", user: null, error: null }; setWd({ connected: false, email: null }); emitAuth(); });
  };

  function cleanUrl() {
    try { history.replaceState(null, "", window.location.pathname + window.location.search); } catch (e) { /* cosmetic */ }
  }

  // Reads the fragment Zoho/our API redirected back with, restores the session, and loads the user.
  auth.init = function () {
    var frag = new URLSearchParams((window.location.hash || "").replace(/^#/, ""));
    var pendingConnect = null;
    if (frag.get("sp_token")) { auth.tok = frag.get("sp_token"); storage("set", TOKEN_KEY, auth.tok); cleanUrl(); }
    else if (frag.get("sp_error")) { auth.state.error = LOGIN_ERRORS[frag.get("sp_error")] || LOGIN_ERRORS.login_failed; cleanUrl(); }
    if (frag.get("wd_code") && frag.get("wd_state")) {
      pendingConnect = { code: frag.get("wd_code"), state: frag.get("wd_state"), server: frag.get("wd_server") || "" };
      cleanUrl();
    } else if (frag.get("wd_error")) {
      cleanUrl(); setTimeout(function () { S.toast("WorkDrive access was not granted.", "err"); }, 300);
    }
    if (!auth.tok) auth.tok = storage("get", TOKEN_KEY);

    if (!auth.tok) { auth.state = { status: "anonymous", user: null, error: auth.state.error }; emitAuth(); return Promise.resolve(); }

    return S.api("/auth/me", { timeoutMs: 20000 }).then(function (r) {
      auth.state = { status: "authenticated", user: r.user, error: null };
      var w = r.workdrive || {};
      setWd({ connected: !!w.connected, email: w.account && w.account.email || null });
      emitAuth();
      if (pendingConnect) return wd.completeConnect(pendingConnect);
    }).catch(function (e) {
      if (e.status === 401) { auth.tok = null; storage("remove", TOKEN_KEY); auth.state = { status: "anonymous", user: null, error: null }; }
      else auth.state = { status: "anonymous", user: null, error: e.message };
      emitAuth();
    });
  };

  /* ---------- Zoho WorkDrive connection (separate from sign-in) ---------- */
  wd.onChange = function (fn) { wd.listeners.push(fn); fn(wd.state); };

  wd.markDisconnected = function () {
    if (!wd.state.connected) return;
    setWd({ connected: false, email: null });
    S.toast("Your WorkDrive connection needs to be re-authorised.", "err");
  };

  // Full-page redirect to Zoho's consent screen. Shown only until the user approves once; the
  // backend then keeps the refresh token until they press Disconnect.
  wd.connect = function () {
    setWd({ busy: true });
    return S.api("/workdrive/authorize", { timeoutMs: 20000 }).then(function (res) {
      if (!res.authorize_url || !res.binding) throw new Error("The server did not return a sign-in link.");
      storage("set", BINDING_KEY, res.binding);
      window.location.assign(res.authorize_url);
      return new Promise(function () { /* the page is navigating away */ });
    }).catch(function (e) { setWd({ busy: false }); throw e; });
  };

  wd.completeConnect = function (p) {
    var binding = storage("get", BINDING_KEY);
    storage("remove", BINDING_KEY);
    if (!binding) { S.toast("That WorkDrive connection attempt expired. Please try again.", "err"); return Promise.resolve(); }
    setWd({ busy: true });
    return S.api("/workdrive/connect", { method: "POST", json: { code: p.code, state: p.state, binding: binding, accounts_server: p.server || undefined }, timeoutMs: 30000 })
      .then(function (r) {
        setWd({ connected: true, email: r.account && r.account.email || null, busy: false });
        S.toast("WorkDrive connected.", "ok");
      }).catch(function (e) { setWd({ busy: false }); S.toast(e.message, "err", 7000); });
  };

  wd.disconnect = function () {
    setWd({ busy: true });
    return S.api("/workdrive/disconnect", { method: "POST", timeoutMs: 20000 })
      .then(function () { setWd({ connected: false, email: null, busy: false }); S.toast("WorkDrive disconnected.", "ok"); })
      .catch(function (e) { setWd({ busy: false }); S.toast(e.message, "err"); });
  };

  /* Sign-in screen shown to anyone who is not signed in. */
  function renderLogin(message) {
    document.title = (document.title.split("|")[0] || "Spikra").trim() + " | Sign in";
    S.mount(document.body, el("div", { class: "sp-fullpage" },
      el("div", { class: "sp-card", style: "max-width:420px;width:100%;padding:36px 28px" },
        el("div", { class: "sp-brand", style: "justify-content:center;color:var(--deep);margin-bottom:14px" }, el("span", { class: "dot" }), "Spikra Sales Hub"),
        el("h1", { style: "margin-bottom:8px" }, "Sign in to continue"),
        el("p", { class: "sp-muted", style: "margin-bottom:20px" }, "Use your Spikra Zoho account. Your session stays private to you."),
        message ? el("div", { class: "sp-banner err", role: "alert", style: "margin-bottom:16px;text-align:left" }, message) : null,
        el("button", { class: "sp-btn primary", style: "width:100%", onclick: function () { auth.login(); } }, "Sign in with Zoho"))));
  }

  // Boots a workspace app: handles the sign-in redirect, shows the login screen when needed,
  // and calls start() once the user is authenticated.
  S.boot = function (start) {
    var started = false;
    auth.onChange(function (st) {
      if (st.status === "authenticated" && !started) { started = true; start(); }
      else if (st.status === "anonymous") { started = false; renderLogin(st.error); }
    });
    auth.init();
  };

  /* Header widget: signed-in user, WorkDrive status and sign out. */
  S.mountUserMenu = function (container) {
    function render() {
      var st = wd.state, user = auth.state.user || {};
      var wdButton = st.connected
        ? el("button", { class: "sp-btn small", disabled: st.busy, onclick: function () { S.confirm("Disconnect WorkDrive?", "You will need to approve WorkDrive access again to pick files from it.", "Disconnect").then(function (y) { if (y) wd.disconnect(); }); } }, "Disconnect")
        : el("button", { class: "sp-btn small primary", disabled: st.busy, onclick: function () { wd.connect().catch(function (e) { S.toast(e.message, "err"); }); } }, st.busy ? el("span", { class: "sp-spin" }) : null, "Connect Zoho WorkDrive");
      S.mount(container, el("div", { class: "sp-row", style: "gap:14px" },
        el("div", { class: "sp-conn" + (st.connected ? " on" : "") }, el("span", { class: "dot" }),
          el("span", { class: "sp-ellipsis", style: "max-width:200px" }, st.connected ? "WorkDrive: " + (st.email || "connected") : "WorkDrive not connected"), wdButton),
        el("span", { class: "sp-ellipsis sp-small", style: "max-width:200px;opacity:.85", title: user.email || "" }, user.displayName || user.email || ""),
        el("button", { class: "sp-btn small", onclick: function () { auth.logout(); } }, "Sign out")));
    }
    wd.onChange(render);
    auth.onChange(render);
  };

  /* ---------- Modal + confirm ---------- */
  S.modal = function (opts) {
    var previouslyFocused = document.activeElement;
    var overlay = el("div", { class: "sp-overlay", role: "presentation" });
    var closeBtn = el("button", { class: "sp-btn small ghost", "aria-label": "Close" }, "✕");
    var head = el("div", { class: "sp-modal-head" }, el("h2", { id: "sp-modal-title" }, opts.title || ""), closeBtn);
    var body = el("div", { class: "sp-modal-body" });
    var foot = el("div", { class: "sp-modal-foot" });
    var dialog = el("div", { class: "sp-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "sp-modal-title" }, head, body, opts.noFooter ? null : foot);
    overlay.appendChild(dialog);
    var closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      if (opts.onClose) opts.onClose(result);
    }
    function onKey(e) { if (e.key === "Escape") close(null); }
    closeBtn.addEventListener("click", function () { close(null); });
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    closeBtn.focus();
    return { body: body, foot: foot, close: close };
  };

  S.confirm = function (title, message, confirmLabel) {
    return new Promise(function (resolve) {
      var m = S.modal({ title: title, onClose: function (r) { resolve(r === true); } });
      m.body.appendChild(el("div", { class: "sp-card-body" }, el("p", {}, message)));
      m.foot.appendChild(el("span"));
      m.foot.appendChild(el("div", { class: "sp-row" },
        el("button", { class: "sp-btn", onclick: function () { m.close(false); } }, "Cancel"),
        el("button", { class: "sp-btn dark", onclick: function () { m.close(true); } }, confirmLabel || "Confirm")));
    });
  };

  /* ---------- WorkDrive file picker ---------- */
  S.pickFromWorkdrive = function (opts) {
    opts = opts || {};
    var accept = (opts.accept || []).map(function (x) { return x.toLowerCase(); });
    var multiple = !!opts.multiple;

    function ensureConnected() {
      if (wd.state.connected) return Promise.resolve();
      return S.confirm("Connect Zoho WorkDrive", "Approve WorkDrive access once and it stays connected until you disconnect. You will be taken to Zoho and returned here.", "Continue to Zoho")
        .then(function (yes) { return yes ? wd.connect() : Promise.reject(new Error("WorkDrive was not connected.")); });
    }

    return ensureConnected().then(function () {
      return new Promise(function (resolve) {
        var stack = [{ id: null, name: "WorkDrive" }];
        var items = [];
        var selected = {};
        var loading = false;
        var error = null;
        var filter = "";
        var requestToken = 0;

        var m = S.modal({ title: opts.title || "Pick from Zoho WorkDrive", onClose: function (r) { resolve(r || null); } });
        var crumbs = el("div", { class: "sp-crumbs" });
        var search = el("input", {
          class: "sp-input", type: "search", placeholder: "Filter this folder, or press Enter at the top level to find a client folder",
          "aria-label": "Search WorkDrive", style: "margin:12px 20px;width:calc(100% - 40px)",
          oninput: function (e) { filter = e.target.value.trim().toLowerCase(); renderList(); },
          onkeydown: function (e) { if (e.key === "Enter" && stack.length === 1 && e.target.value.trim()) findClient(e.target.value.trim()); }
        });
        var list = el("div", { class: "sp-list", style: "min-height:180px" });
        m.body.appendChild(crumbs); m.body.appendChild(search); m.body.appendChild(list);
        var count = el("span", { class: "sp-muted sp-small" });
        var confirmBtn = el("button", {
          class: "sp-btn primary", disabled: true,
          onclick: function () { m.close(Object.keys(selected).map(function (k) { return selected[k]; })); }
        }, "Use selected");
        m.foot.appendChild(count);
        m.foot.appendChild(el("div", { class: "sp-row" }, el("button", { class: "sp-btn", onclick: function () { m.close(null); } }, "Cancel"), confirmBtn));

        function load(folderId, afterLoad) {
          var mine = ++requestToken;
          loading = true; error = null; renderList();
          S.api("/workdrive/list", { auth: true, query: { folder_id: folderId }, timeoutMs: 45000 }).then(function (res) {
            if (mine !== requestToken) return;
            items = (res.items || []).slice().sort(function (a, b) { return (b.isFolder - a.isFolder) || String(a.name).localeCompare(String(b.name)); });
            loading = false; if (afterLoad) afterLoad(res); renderAll();
          }).catch(function (e) {
            if (mine !== requestToken) return;
            loading = false; error = e.message;
            if (e.status === 401 || e.code === "WORKDRIVE_NOT_CONNECTED" || e.code === "WORKDRIVE_TOKEN_EXPIRED") { m.close(null); return; }
            renderAll();
          });
        }

        function findClient(query) {
          var mine = ++requestToken;
          loading = true; error = null; renderList();
          S.api("/workdrive/list", { auth: true, query: { query: query }, timeoutMs: 90000 }).then(function (res) {
            if (mine !== requestToken) return;
            loading = false;
            if (!res.matched) { S.toast("No folder matches “" + query + "”.", "err"); renderList(); return; }
            stack = [{ id: null, name: "WorkDrive" }].concat((res.breadcrumb || []).map(function (b) { return { id: b.id, name: b.name }; }));
            items = (res.items || []).slice().sort(function (a, b) { return (b.isFolder - a.isFolder) || String(a.name).localeCompare(String(b.name)); });
            search.value = ""; filter = ""; renderAll();
          }).catch(function (e) { if (mine !== requestToken) return; loading = false; error = e.message; renderAll(); });
        }

        function open(index) {
          stack = stack.slice(0, index + 1); filter = ""; search.value = "";
          load(stack[index].id);
        }

        function toggle(item) {
          if (!multiple) selected = {};
          if (selected[item.id]) delete selected[item.id]; else selected[item.id] = { id: item.id, name: item.name, size: item.size, extension: item.extension };
          renderAll();
        }

        function renderCrumbs() {
          S.mount(crumbs, stack.map(function (c, i) {
            return [i ? el("span", { class: "sp-muted" }, "/") : null,
              el("button", { type: "button", disabled: i === stack.length - 1, onclick: function () { open(i); } }, c.name)];
          }));
        }

        function renderList() {
          if (loading) {
            return S.mount(list, [1, 2, 3, 4].map(function () { return el("div", { class: "sp-item" }, el("div", { class: "sp-skel", style: "width:100%;height:18px" })); }));
          }
          if (error) {
            return S.mount(list, el("div", { class: "sp-empty" }, el("strong", {}, "Couldn’t load WorkDrive"), el("p", {}, error),
              el("button", { class: "sp-btn small", style: "margin-top:12px", onclick: function () { load(stack[stack.length - 1].id); } }, "Try again")));
          }
          var visible = items.filter(function (it) { return !filter || String(it.name).toLowerCase().indexOf(filter) >= 0; });
          if (!visible.length) {
            return S.mount(list, el("div", { class: "sp-empty" }, el("strong", {}, items.length ? "Nothing matches your filter" : "This folder is empty")));
          }
          S.mount(list, visible.map(function (it) {
            if (it.isFolder) {
              return el("div", { class: "sp-item clickable", role: "button", tabindex: "0",
                onclick: function () { stack.push({ id: it.id, name: it.name }); filter = ""; search.value = ""; load(it.id); },
                onkeydown: function (e) { if (e.key === "Enter") e.currentTarget.click(); } },
                el("span", { class: "sp-file", style: "border:0;padding:0" }, el("span", { class: "ico" }, "DIR")),
                el("div", { class: "sp-grow sp-ellipsis" }, it.name), el("span", { class: "sp-muted sp-small" }, "Open ›"));
            }
            var ok = !accept.length || accept.indexOf(String(it.extension || "").toLowerCase()) >= 0;
            var picked = !!selected[it.id];
            return el("label", { class: "sp-item" + (ok ? " clickable" : ""), title: ok ? "" : "Unsupported file type", style: ok ? "" : "opacity:.5;cursor:not-allowed" },
              el("input", { type: multiple ? "checkbox" : "radio", name: "wd-pick", checked: picked, disabled: !ok, onchange: function () { toggle(it); } }),
              el("span", { class: "sp-file", style: "border:0;padding:0" }, el("span", { class: "ico" }, (it.extension || "FILE").replace(".", "").slice(0, 4).toUpperCase())),
              el("div", { class: "sp-grow sp-ellipsis" }, it.name),
              el("span", { class: "sp-muted sp-small" }, S.fmtBytes(it.size)));
          }));
        }

        function renderFoot() {
          var n = Object.keys(selected).length;
          count.textContent = n ? n + " selected" : (accept.length ? "Supported: " + accept.join(", ") : "");
          confirmBtn.disabled = n === 0;
        }
        function renderAll() { renderCrumbs(); renderList(); renderFoot(); }

        renderAll();
        load(null);
      });
    });
  };

  /* ---------- Generic helpers used by both apps ---------- */
  S.statusChip = function (status) {
    var s = String(status || "").toUpperCase();
    var kind = "";
    if (["PUBLISHED", "COMPLETED", "APPROVED", "EXTRACTED", "UPLOADED"].indexOf(s) >= 0) kind = "ok";
    else if (["FAILED", "ERROR"].indexOf(s) >= 0) kind = "err";
    else if (["PROCESSING", "ANALYZING", "GENERATING", "DEPLOYING", "IN REVIEW", "PENDING"].indexOf(s) >= 0) kind = "warn";
    else if (s) kind = "info";
    return el("span", { class: "sp-chip " + kind }, s ? s.charAt(0) + s.slice(1).toLowerCase() : "Unknown");
  };

  S.steps = function (container, defs) {
    var nodes = defs.map(function (d) {
      var mark = el("span", { class: "mark" }, "•");
      var sub = el("div", { class: "sub" }, d.sub || "");
      var node = el("div", { class: "sp-step" }, mark, el("div", {}, el("div", { class: "label" }, d.label), sub));
      return { id: d.id, node: node, mark: mark, sub: sub };
    });
    S.mount(container, nodes.map(function (n) { return n.node; }));
    return {
      set: function (id, state, text) {
        var seenActive = false;
        nodes.forEach(function (n) {
          if (n.id !== id) return;
          n.node.className = "sp-step " + state;
          n.mark.textContent = state === "done" ? "✓" : state === "failed" ? "!" : "•";
          if (text !== undefined) n.sub.textContent = text;
          seenActive = true;
        });
        return seenActive;
      },
      reset: function () { nodes.forEach(function (n) { n.node.className = "sp-step"; n.mark.textContent = "•"; n.sub.textContent = ""; }); }
    };
  };

  S.dropzone = function (opts) {
    var input = el("input", { type: "file", hidden: true, accept: (opts.accept || []).join(","), multiple: !!opts.multiple });
    var zone = el("div", { class: "sp-drop", role: "button", tabindex: "0", "aria-label": opts.label || "Choose a file" },
      el("strong", {}, opts.label || "Drop a file here or click to browse"), el("span", { class: "sp-muted sp-small" }, opts.hint || ""));
    function take(files) { if (files && files.length) opts.onFiles(Array.prototype.slice.call(files)); }
    zone.addEventListener("click", function () { input.click(); });
    zone.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    zone.addEventListener("dragover", function (e) { e.preventDefault(); zone.classList.add("over"); });
    zone.addEventListener("dragleave", function () { zone.classList.remove("over"); });
    zone.addEventListener("drop", function (e) { e.preventDefault(); zone.classList.remove("over"); take(e.dataTransfer && e.dataTransfer.files); });
    input.addEventListener("change", function () { take(input.files); input.value = ""; });
    return el("div", {}, zone, input);
  };

  S.fileRow = function (name, meta, onRemove) {
    return el("div", { class: "sp-file" },
      el("span", { class: "ico" }, (S.extOf(name).replace(".", "") || "file").slice(0, 4).toUpperCase()),
      el("div", { class: "sp-grow" }, el("div", { class: "sp-ellipsis", title: name }, name), meta ? el("div", { class: "sp-muted sp-small" }, meta) : null),
      onRemove ? el("button", { class: "sp-btn small ghost danger", type: "button", "aria-label": "Remove " + name, onclick: onRemove }, "Remove") : null);
  };

  S.fullpageMessage = function (title, message, actionLabel, onAction) {
    S.mount(document.body, el("div", { class: "sp-fullpage" },
      el("h1", {}, title), el("p", { class: "sp-muted", style: "max-width:460px" }, message),
      actionLabel ? el("button", { class: "sp-btn dark", onclick: onAction }, actionLabel) : null));
  };

  /* Renders server-generated proposal HTML in a full-screen frame that cannot navigate the top page. */
  S.renderDocumentFrame = function (html, title) {
    var frame = el("iframe", {
      class: "sp-frame", title: title || "Document",
      sandbox: "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms"
    });
    S.mount(document.body, frame);
    frame.srcdoc = html;
  };

  /* Fetches a server-rendered document (HTML) from the API. */
  S.fetchDocument = function (path, query) {
    S.assertConfigured();
    var qs = new URLSearchParams();
    Object.keys(query || {}).forEach(function (k) { if (query[k]) qs.set(k, query[k]); });
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 30000);
    return fetch(API_BASE + path + "?" + qs.toString(), { signal: controller.signal, credentials: "omit" })
      .catch(function (e) {
        throw ApiError(0, "NETWORK", e && e.name === "AbortError" ? "Loading timed out." : "Could not reach the server.");
      })
      .then(function (res) {
        clearTimeout(timer);
        return res.text().then(function (text) {
          if (!res.ok || !text) throw ApiError(res.status, "REQUEST_FAILED", res.status === 404 ? "This link could not be found. It may have been removed." : "The server returned an error (HTTP " + res.status + ").");
          return text;
        });
      });
  };

  global.Spikra = S;
})(window);
