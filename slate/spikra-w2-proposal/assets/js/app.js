/* Solution Proposals workspace: discovery sessions -> files (computer or Zoho WorkDrive) -> generated proposal. */
(function () {
  "use strict";
  var S = window.Spikra;
  var el = S.el;

  var ACCEPT = [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".txt", ".csv", ".md"];
  var MAX_FILE = 25 * 1024 * 1024;
  var MAX_TOTAL = 120 * 1024 * 1024;
  var TRANSITIONS = { "Draft": ["In Review"], "In Review": ["Approved", "Draft"], "Approved": [] };
  var DOC_LABELS = { technical: "Technical document", commercial: "Commercial proposal", tos: "Terms of service" };
  var POLL_MS = 3000;
  var MAX_WAIT_MS = 12 * 60 * 1000;

  var state = { sessions: null, sessionsError: null, selectedId: null, detail: null, detailError: null, proposals: null, proposalsError: null, busy: false, run: null };
  var ui = {};

  /* ---------- data ---------- */
  function loadSessions() {
    state.sessionsError = null;
    return S.api("/proposal/discovery", { auth: true }).then(function (r) {
      state.sessions = r.sessions || r.packages || [];
    }).catch(function (e) { state.sessionsError = e.message; state.sessions = state.sessions || []; })
      .then(renderSessions);
  }

  function loadProposals() {
    state.proposalsError = null;
    return S.api("/proposal/api", { auth: true, query: { resource: "proposals" } }).then(function (r) {
      state.proposals = r.proposals || [];
    }).catch(function (e) { state.proposalsError = e.message; state.proposals = state.proposals || []; })
      .then(renderProposals);
  }

  function selectSession(id) {
    state.selectedId = id; state.detail = null; state.detailError = null; state.run = null;
    renderSessions(); renderDetail();
    return S.api("/proposal/discovery", { auth: true, query: { package_id: id } }).then(function (r) {
      if (state.selectedId !== id) return;
      state.detail = r.session || r.package;
      var done = String(state.detail.status || "").toUpperCase() === "COMPLETED";
      renderDetail();
      if (done) return fetchRunStatus(id);
    }).catch(function (e) {
      if (state.selectedId !== id) return;
      state.detailError = e.message; renderDetail();
    });
  }

  function refreshDetail() {
    var id = state.selectedId;
    return S.api("/proposal/discovery", { auth: true, query: { package_id: id } }).then(function (r) {
      if (state.selectedId === id) { state.detail = r.session || r.package; renderDetail(); }
    });
  }

  function fetchRunStatus(id) {
    return S.api("/proposal/processor/status", { auth: true, query: { session_id: id } }).then(function (r) {
      if (state.selectedId !== id) return null;
      if (String(r.status).toUpperCase() === "COMPLETED") state.run = { phase: "done", result: r };
      renderDetail();
      return r;
    }).catch(function () { /* status is advisory when a session has no proposal yet */ });
  }

  /* ---------- file helpers ---------- */
  function checkFiles(files, existingBytes) {
    var ok = [], problems = [], total = existingBytes || 0;
    files.forEach(function (f) {
      if (ACCEPT.indexOf(S.extOf(f.name)) < 0) problems.push(f.name + ": unsupported type");
      else if (f.size > MAX_FILE) problems.push(f.name + ": larger than 25 MB");
      else if (f.size === 0) problems.push(f.name + ": file is empty");
      else if (total + f.size > MAX_TOTAL) problems.push(f.name + ": would exceed the 120 MB total limit");
      else { total += f.size; ok.push(f); }
    });
    return { ok: ok, problems: problems };
  }

  function multipartBody(files, extra) {
    var fd = new FormData();
    files.forEach(function (f) { fd.append("files", f, f.name); });
    Object.keys(extra || {}).forEach(function (k) { fd.append(k, extra[k]); });
    return fd;
  }

  function uploadLocal(files, opts) {
    var req = { method: "POST", auth: true, timeoutMs: 300000, body: multipartBody(files, opts.sessionName ? { session_name: opts.sessionName } : {}) };
    if (opts.packageId) req.query = { package_id: opts.packageId, action: "add_files" };
    return S.api("/proposal/discovery", req);
  }

  function addFromWorkdrive(fileIds, opts) {
    var body = { action: "add_from_workdrive", file_ids: fileIds };
    if (opts.packageId) body.package_id = opts.packageId; else body.session_name = opts.sessionName;
    return S.api("/proposal/discovery", { method: "POST", auth: true, json: body, timeoutMs: 300000 });
  }

  /* ---------- generation ---------- */
  function generate() {
    var id = state.selectedId;
    if (state.run && state.run.phase === "running") return;
    var started = Date.now();
    var run = { phase: "running", stage: "PROCESSING", message: "Starting…", id: id };
    state.run = run; renderDetail();

    var stopped = false;
    function stop() { stopped = true; }

    var request = S.api("/proposal/processor/process", { method: "POST", auth: true, query: { session_id: id }, timeoutMs: 6 * 60 * 1000 })
      .then(function (r) { return { ok: true, result: r }; }, function (e) { return { ok: false, error: e }; });

    function finish(result) {
      stop();
      if (state.selectedId === id) { state.run = { phase: "done", result: result }; renderDetail(); }
      S.toast("Proposal generated.", "ok");
      loadSessions(); loadProposals();
    }
    function fail(message) {
      stop();
      if (state.selectedId === id) { state.run = { phase: "failed", message: message }; renderDetail(); }
      S.toast(message, "err");
    }

    request.then(function (outcome) {
      if (stopped) return;
      if (outcome.ok && String(outcome.result.status).toUpperCase() === "COMPLETED") return finish(outcome.result);
      if (!outcome.ok && outcome.error.code !== "NETWORK") return fail(outcome.error.message);
      /* in-progress response or a dropped connection: the status poll below decides */
    });

    (function poll() {
      if (stopped) return;
      S.sleep(POLL_MS).then(function () {
        if (stopped) return;
        if (Date.now() - started > MAX_WAIT_MS) return fail("Generation is taking longer than expected. Check back in a few minutes.");
        return S.api("/proposal/processor/status", { auth: true, query: { session_id: id } }).then(function (r) {
          if (stopped) return;
          var stage = String(r.status || "").toUpperCase();
          if (stage === "COMPLETED") return finish(r);
          if (stage === "FAILED") return fail("Proposal generation failed. Please try again.");
          run.stage = stage; run.message = r.extracted_count + " of " + r.document_count + " documents read";
          if (state.selectedId === id) renderRun();
          poll();
        }).catch(function (e) { if (e.status === 401) return stop(); poll(); });
      }, stop);
    })();
  }

  /* ---------- renderers ---------- */
  function renderSessions() {
    var list = state.sessions;
    var body;
    if (list === null) body = [1, 2, 3].map(function () { return el("div", { class: "sp-item" }, el("div", { class: "sp-skel", style: "width:100%;height:36px" })); });
    else if (state.sessionsError && !list.length) body = el("div", { class: "sp-empty" }, el("strong", {}, "Couldn’t load sessions"), el("p", {}, state.sessionsError),
      el("button", { class: "sp-btn small", style: "margin-top:10px", onclick: loadSessions }, "Try again"));
    else if (!list.length) body = el("div", { class: "sp-empty" }, el("strong", {}, "No discovery sessions yet"), el("p", {}, "Create one, add your discovery documents, then generate a proposal."));
    else body = list.map(function (s) {
      var id = s.session_id || s.package_id;
      return el("div", { class: "sp-item clickable" + (id === state.selectedId ? " active" : ""), role: "button", tabindex: "0",
        onclick: function () { selectSession(id); }, onkeydown: function (e) { if (e.key === "Enter") selectSession(id); } },
        el("div", { class: "sp-grow" }, el("div", { class: "sp-ellipsis", style: "font-weight:600" }, s.session_name || s.package_name || "Untitled session"),
          el("div", { class: "sp-muted sp-small" }, S.fmtDate(s.created_at))),
        S.statusChip(s.status));
    });
    S.mount(ui.sessions, [
      el("div", { class: "sp-card-head" }, el("h2", {}, "Discovery sessions"),
        el("button", { class: "sp-btn small primary", onclick: openNewSession }, "+ New session")),
      el("div", { class: "sp-list" }, body)
    ]);
  }

  function renderDetail() {
    if (!state.selectedId) {
      return S.mount(ui.detail, el("div", { class: "sp-card" }, el("div", { class: "sp-empty", style: "padding:56px 20px" },
        el("strong", {}, "Select or create a discovery session"), el("p", {}, "Gather your client’s documents in one session, then generate a full solution proposal from them."))));
    }
    if (state.detailError) {
      return S.mount(ui.detail, el("div", { class: "sp-card" }, el("div", { class: "sp-empty" }, el("strong", {}, "Couldn’t open this session"), el("p", {}, state.detailError),
        el("button", { class: "sp-btn small", style: "margin-top:10px", onclick: function () { selectSession(state.selectedId); } }, "Try again"))));
    }
    if (!state.detail) {
      return S.mount(ui.detail, el("div", { class: "sp-card" }, el("div", { class: "sp-card-body sp-stack" },
        el("div", { class: "sp-skel", style: "height:24px;width:50%" }), el("div", { class: "sp-skel", style: "height:56px" }), el("div", { class: "sp-skel", style: "height:56px" }))));
    }

    var d = state.detail;
    var files = d.files || [];
    var running = state.run && state.run.phase === "running";
    var totalBytes = files.reduce(function (n, f) { return n + (Number(f.file_size) || 0); }, 0);

    var dropzone = S.dropzone({
      accept: ACCEPT, multiple: true, label: "Drop documents here or click to browse",
      hint: "PDF, Word, Excel, text · up to 25 MB each",
      onFiles: function (picked) { addLocal(picked, totalBytes); }
    });

    ui.runBox = el("div");
    S.mount(ui.detail, [
      el("div", { class: "sp-card" },
        el("div", { class: "sp-card-head" },
          el("div", { class: "sp-grow" }, el("h2", { class: "sp-ellipsis" }, d.session_name || d.package_name || "Discovery session"),
            el("div", { class: "sp-muted sp-small" }, files.length + (files.length === 1 ? " document" : " documents") + (d.created_at ? " · created " + S.fmtDate(d.created_at) : ""))),
          S.statusChip(d.status)),
        el("div", { class: "sp-card-body sp-stack" },
          el("div", { class: "sp-stack", style: "gap:8px" }, files.length ? files.map(function (f) {
            return S.fileRow(f.file_name, [S.fmtBytes(f.file_size), String(f.source_type || "").indexOf("WORKDRIVE") >= 0 ? "WorkDrive" : "Uploaded"].join(" · "),
              running ? null : function () { removeFile(f); });
          }) : el("div", { class: "sp-banner info" }, "No documents yet. Add at least one to generate a proposal.")),
          el("div", { class: "sp-row" },
            el("div", { class: "sp-grow", style: "min-width:240px" }, dropzone),
            el("button", { class: "sp-btn", disabled: running, onclick: function () { addFromWd(totalBytes); } }, "Pick from WorkDrive")),
          ui.runBox))
    ]);
    renderRun();
  }

  function renderRun() {
    if (!ui.runBox) return;
    var files = (state.detail && state.detail.files) || [];
    var run = state.run;

    if (run && run.phase === "running") {
      var stages = { PROCESSING: 1, ANALYZING: 2, GENERATING: 3 };
      var idx = stages[run.stage] || 1;
      var box = el("div", { class: "sp-steps" });
      var defs = [{ id: "read", label: "Reading your documents" }, { id: "analyze", label: "Analysing with AI" }, { id: "build", label: "Building the proposal documents" }];
      var inst = S.steps(box, defs);
      inst.set("read", idx > 1 ? "done" : "active", idx > 1 ? "" : run.message);
      inst.set("analyze", idx > 2 ? "done" : idx === 2 ? "active" : "", idx === 2 ? "This can take a few minutes." : "");
      inst.set("build", idx === 3 ? "active" : "");
      return S.mount(ui.runBox, el("div", { class: "sp-card", style: "background:var(--paper);box-shadow:none" }, el("div", { class: "sp-card-body sp-stack" },
        el("div", { class: "sp-row" }, el("span", { class: "sp-spin dark" }), el("strong", {}, "Generating your proposal")), box,
        el("div", { class: "sp-bar" }, el("span", { style: "width:" + Math.round((idx / 3) * 100 - 10) + "%" })))));
    }

    if (run && run.phase === "failed") {
      return S.mount(ui.runBox, el("div", { class: "sp-stack" }, el("div", { class: "sp-banner err" }, run.message),
        el("button", { class: "sp-btn dark", onclick: generate }, "Try again")));
    }

    if (run && run.phase === "done") {
      var docs = run.result.documents || {};
      return S.mount(ui.runBox, el("div", { class: "sp-stack" },
        el("div", { class: "sp-banner ok" }, "Proposal ready" + (run.result.customer_name ? " for " + run.result.customer_name : "") + "."),
        el("div", { class: "sp-stack", style: "gap:8px" }, ["commercial", "technical", "tos"].map(function (k) {
          var doc = docs[k]; if (!doc || !doc.url) return null;
          return docRow(DOC_LABELS[k] || doc.name, doc.url);
        }))));
    }

    S.mount(ui.runBox, el("button", { class: "sp-btn primary", disabled: !files.length, onclick: generate }, "Generate proposal"));
  }

  function docRow(label, url) {
    return el("div", { class: "sp-file" }, el("span", { class: "ico" }, "DOC"), el("div", { class: "sp-grow" }, label),
      el("button", { class: "sp-btn small", onclick: function () { S.copyText(url); } }, "Copy link"),
      el("a", { class: "sp-btn small dark", href: url, target: "_blank", rel: "noopener noreferrer", style: "text-decoration:none" }, "Open"));
  }

  function renderProposals() {
    var list = state.proposals;
    var body;
    if (list === null) body = el("div", { class: "sp-item" }, el("div", { class: "sp-skel", style: "width:100%;height:36px" }));
    else if (state.proposalsError && !list.length) body = el("div", { class: "sp-empty" }, el("strong", {}, "Couldn’t load proposals"), el("p", {}, state.proposalsError));
    else if (!list.length) body = el("div", { class: "sp-empty" }, el("strong", {}, "No proposals yet"), el("p", {}, "Generated proposals appear here with their review status."));
    else body = list.map(function (p) {
      var next = TRANSITIONS[p.status] || [];
      var url = p.commercial_url || p.proposal_url;
      return el("div", { class: "sp-item" },
        el("div", { class: "sp-grow" }, el("div", { class: "sp-ellipsis", style: "font-weight:600" }, p.proposal_title || p.customer_name || "Proposal"),
          el("div", { class: "sp-muted sp-small" }, [p.customer_name, S.fmtDate(p.created_at)].filter(Boolean).join(" · "))),
        S.statusChip(p.status),
        next.map(function (to) { return el("button", { class: "sp-btn small", onclick: function () { moveStatus(p, to); } }, "Move to " + to); }),
        url ? el("a", { class: "sp-btn small dark", href: url, target: "_blank", rel: "noopener noreferrer", style: "text-decoration:none" }, "Open") : null);
    });
    S.mount(ui.proposals, el("div", { class: "sp-card" }, el("div", { class: "sp-card-head" }, el("h2", {}, "Proposals"),
      el("button", { class: "sp-btn small", onclick: loadProposals }, "Refresh")), el("div", { class: "sp-list" }, body)));
  }

  /* ---------- actions ---------- */
  function guard(fn) {
    if (state.busy) return Promise.resolve();
    state.busy = true;
    return Promise.resolve().then(fn).then(function (v) { state.busy = false; return v; }, function (e) { state.busy = false; S.toast(e.message, "err"); });
  }

  function addLocal(picked, existingBytes) {
    var check = checkFiles(picked, existingBytes);
    if (check.problems.length) S.toast(check.problems.join("\n"), "err", 7000);
    if (!check.ok.length) return;
    S.toast("Uploading " + check.ok.length + (check.ok.length === 1 ? " file…" : " files…"));
    guard(function () { return uploadLocal(check.ok, { packageId: state.selectedId }).then(function () { S.toast("Documents added.", "ok"); return refreshDetail(); }).then(loadSessions); });
  }

  function addFromWd(existingBytes) {
    S.pickFromWorkdrive({ multiple: true, accept: ACCEPT }).then(function (picked) {
      if (!picked || !picked.length) return;
      var tooBig = picked.filter(function (f) { return f.size > MAX_FILE; });
      if (tooBig.length) { S.toast(tooBig.map(function (f) { return f.name; }).join(", ") + ": larger than 25 MB", "err", 7000); }
      var ids = picked.filter(function (f) { return f.size <= MAX_FILE; }).map(function (f) { return f.id; });
      if (!ids.length) return;
      S.toast("Importing from WorkDrive…");
      return guard(function () { return addFromWorkdrive(ids, { packageId: state.selectedId }).then(function () { S.toast("Documents imported.", "ok"); return refreshDetail(); }).then(loadSessions); });
    }, function (e) { S.toast(e.message, "err"); });
  }

  function removeFile(f) {
    S.confirm("Remove document?", "“" + f.file_name + "” will be removed from this session.", "Remove").then(function (yes) {
      if (!yes) return;
      guard(function () {
        return S.api("/proposal/discovery", { method: "DELETE", auth: true, query: { package_id: state.selectedId, file_id: f.document_id || f.package_file_id } })
          .then(function () { S.toast("Document removed.", "ok"); return refreshDetail(); }).then(loadSessions);
      });
    });
  }

  function moveStatus(p, to) {
    guard(function () {
      return S.api("/proposal/api", { method: "POST", auth: true, query: { proposal_id: p.proposal_id }, json: { status: to } })
        .then(function () { S.toast("Moved to " + to + ".", "ok"); return loadProposals(); });
    });
  }

  function openNewSession() {
    var picked = [];     // local File objects
    var wdPicked = [];   // WorkDrive picks
    var m = S.modal({ title: "New discovery session" });
    var name = el("input", { class: "sp-input", type: "text", maxlength: "150", placeholder: "e.g. Acme Corp – CRM discovery", "aria-label": "Session name" });
    var listBox = el("div", { class: "sp-stack", style: "gap:8px" });
    var submit = el("button", { class: "sp-btn primary" }, "Create session");

    function renderFiles() {
      S.mount(listBox, [].concat(
        picked.map(function (f, i) { return S.fileRow(f.name, S.fmtBytes(f.size) + " · from your computer", function () { picked.splice(i, 1); renderFiles(); }); }),
        wdPicked.map(function (f, i) { return S.fileRow(f.name, S.fmtBytes(f.size) + " · WorkDrive", function () { wdPicked.splice(i, 1); renderFiles(); }); })));
    }

    var dz = S.dropzone({
      accept: ACCEPT, multiple: true, label: "Drop documents here or click to browse", hint: "Optional - you can add documents later",
      onFiles: function (files) {
        var existing = picked.reduce(function (n, f) { return n + f.size; }, 0);
        var res = checkFiles(files, existing);
        if (res.problems.length) S.toast(res.problems.join("\n"), "err", 7000);
        picked = picked.concat(res.ok); renderFiles();
      }
    });

    m.body.appendChild(el("div", { class: "sp-card-body sp-stack" },
      el("div", { class: "sp-field" }, el("label", {}, "Session name"), name),
      dz,
      el("button", { class: "sp-btn", type: "button", onclick: function () {
        S.pickFromWorkdrive({ multiple: true, accept: ACCEPT }).then(function (p) { if (p) { wdPicked = wdPicked.concat(p.filter(function (x) { return x.size <= MAX_FILE; })); renderFiles(); } }, function (e) { S.toast(e.message, "err"); });
      } }, "Pick from WorkDrive"),
      listBox));
    m.foot.appendChild(el("span", { class: "sp-muted sp-small" }, "Files are private to your account."));
    m.foot.appendChild(el("div", { class: "sp-row" }, el("button", { class: "sp-btn", onclick: function () { m.close(null); } }, "Cancel"), submit));

    submit.addEventListener("click", function () {
      var title = name.value.trim() || (picked[0] && picked[0].name.replace(/\.[^.]+$/, "")) || (wdPicked[0] && wdPicked[0].name.replace(/\.[^.]+$/, "")) || "";
      if (!title) { name.classList.add("invalid"); name.focus(); S.toast("Give the session a name.", "err"); return; }
      submit.disabled = true; submit.textContent = "Creating…";
      var chain;
      if (picked.length) chain = uploadLocal(picked, { sessionName: title });
      else if (wdPicked.length) chain = addFromWorkdrive(wdPicked.map(function (f) { return f.id; }), { sessionName: title });
      else chain = S.api("/proposal/discovery", { method: "POST", auth: true, json: { package_name: title } });

      chain.then(function (r) {
        var created = r.session || r.package;
        var id = created.session_id || created.package_id;
        if (picked.length && wdPicked.length) return addFromWorkdrive(wdPicked.map(function (f) { return f.id; }), { packageId: id }).then(function () { return id; });
        return id;
      }).then(function (id) {
        m.close(null); S.toast("Session created.", "ok");
        return loadSessions().then(function () { return selectSession(id); });
      }).catch(function (e) { submit.disabled = false; submit.textContent = "Create session"; S.toast(e.message, "err"); });
    });
    name.focus();
  }

  /* ---------- boot ---------- */
  function renderWorkspace() {
    ui.sessions = el("div", { class: "sp-card" }); ui.detail = el("div"); ui.proposals = el("div");
    S.mount(ui.main, el("div", { class: "sp-grid" }, ui.sessions, el("div", { class: "sp-stack", style: "gap:24px" }, ui.detail, ui.proposals)));
    renderSessions(); renderDetail(); renderProposals();
    loadSessions(); loadProposals();
  }

  function start() {
    document.title = "Solution Proposals | Spikra";
    var widget = el("div");
    ui.main = el("main", { class: "sp-shell" });
    S.mount(document.body, [
      el("header", { class: "sp-topbar" }, el("div", { class: "sp-brand" }, el("span", { class: "dot" }), "Spikra ", el("small", {}, "Solution Proposals")), widget),
      ui.main
    ]);
    S.mountUserMenu(widget);
    renderWorkspace();
  }

  if (window.W2Viewer.wants()) window.W2Viewer.start(); else S.boot(start);
})();
