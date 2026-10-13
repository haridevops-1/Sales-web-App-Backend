/* Customer Showcases workspace: upload a document -> AI analysis -> published, shareable showcase link. */
(function () {
  "use strict";
  var S = window.Spikra;
  var el = S.el;

  var DOC_ACCEPT = [".pdf", ".docx"];
  var LOGO_ACCEPT = [".png", ".jpg", ".jpeg", ".webp", ".svg"];
  var MAX_DOC = 99 * 1024 * 1024;
  var MAX_LOGO = 5 * 1024 * 1024;
  var ANALYZE_POLL_MS = 5000;
  var ANALYZE_MAX_MS = 12 * 60 * 1000;
  var LIST_REFRESH_MS = 15000;
  var IN_PROGRESS = ["UPLOADED", "PROCESSING", "EXTRACTED", "ANALYZING", "GENERATING", "GENERATED", "DEPLOYING"];

  var STEPS = [
    { id: "upload", label: "Uploading your document" },
    { id: "extract", label: "Reading the document" },
    { id: "analyze", label: "Analysing with AI", sub: "" },
    { id: "generate", label: "Designing the showcase" },
    { id: "publish", label: "Publishing your link" }
  ];

  var form = { source: "computer", file: null, wdFile: null, logo: null, logoUrl: null };
  var list = { items: null, error: null, search: "", status: "" };
  var run = null;         // { phase: running|failed|done, ids, next, error, url, name }
  var ui = {};
  var timer = null;

  /* ---------- list ---------- */
  function loadList(silent) {
    if (!silent) { list.error = null; }
    return S.api("/spikra/experience/list", { timeoutMs: 45000 }).then(function (r) {
      list.items = r.experiences || []; list.error = null;
    }).catch(function (e) { list.error = e.message; if (list.items === null) list.items = []; })
      .then(function () { renderList(); scheduleRefresh(); });
  }

  function scheduleRefresh() {
    clearTimeout(timer);
    var active = (list.items || []).some(function (x) { return IN_PROGRESS.indexOf(String(x.status).toUpperCase()) >= 0; });
    if (active && !(run && run.phase === "running")) {
      timer = setTimeout(function () { if (!document.hidden) loadList(true); else scheduleRefresh(); }, LIST_REFRESH_MS);
    }
  }

  function renderList() {
    var items = list.items;
    var body;
    if (items === null) {
      body = [1, 2, 3].map(function () { return el("div", { class: "sp-item" }, el("div", { class: "sp-skel", style: "width:100%;height:40px" })); });
    } else {
      var q = list.search.trim().toLowerCase();
      var shown = items.filter(function (x) {
        if (list.status && String(x.status).toUpperCase() !== list.status) return false;
        return !q || [x.business_name, x.experience_title].join(" ").toLowerCase().indexOf(q) >= 0;
      });
      if (list.error && !items.length) {
        body = el("div", { class: "sp-empty" }, el("strong", {}, "Couldn’t load showcases"), el("p", {}, list.error),
          el("button", { class: "sp-btn small", style: "margin-top:10px", onclick: function () { loadList(); } }, "Try again"));
      } else if (!items.length) {
        body = el("div", { class: "sp-empty" }, el("strong", {}, "No showcases yet"), el("p", {}, "Create your first showcase using the form."));
      } else if (!shown.length) {
        body = el("div", { class: "sp-empty" }, el("strong", {}, "No showcases match your filters"));
      } else {
        body = shown.map(showcaseRow);
      }
    }
    S.mount(ui.list, [
      el("div", { class: "sp-card-head" }, el("h2", {}, "Your showcases"), el("button", { class: "sp-btn small", onclick: function () { loadList(); } }, "Refresh")),
      el("div", { class: "sp-row", style: "padding:12px 20px;border-bottom:1px solid var(--line)" },
        el("input", { class: "sp-input sp-grow", type: "search", placeholder: "Search by business or title", value: list.search, "aria-label": "Search showcases",
          oninput: function (e) { list.search = e.target.value; renderListBody(); } }),
        el("select", { class: "sp-select", style: "width:auto", "aria-label": "Filter by status", onchange: function (e) { list.status = e.target.value; renderListBody(); } },
          [["", "All statuses"], ["PUBLISHED", "Published"], ["FAILED", "Failed"], ["GENERATED", "Generated"]].map(function (o) {
            return el("option", { value: o[0], selected: list.status === o[0] }, o[1]);
          }))),
      el("div", { class: "sp-list", id: "sp-list-body" }, body)
    ]);
  }

  function renderListBody() {
    var keepSearch = document.activeElement && document.activeElement.type === "search";
    var pos = keepSearch ? document.activeElement.selectionStart : null;
    renderList();
    if (keepSearch) { var box = ui.list.querySelector("input[type=search]"); if (box) { box.focus(); box.setSelectionRange(pos, pos); } }
  }

  function showcaseRow(x) {
    var published = String(x.status).toUpperCase() === "PUBLISHED" && x.generated_url;
    return el("div", { class: "sp-item" },
      el("div", { class: "sp-grow" },
        el("div", { class: "sp-ellipsis", style: "font-weight:600" }, x.business_name || x.experience_title || "Untitled showcase"),
        el("div", { class: "sp-muted sp-small sp-ellipsis" }, [x.experience_title, S.fmtDate(x.published_time || x.created_time)].filter(Boolean).join(" · ")),
        String(x.status).toUpperCase() === "FAILED" && x.error_message ? el("div", { class: "sp-small", style: "color:var(--err)" }, x.error_message) : null),
      S.statusChip(x.status),
      published ? el("button", { class: "sp-btn small", onclick: function () { S.copyText(x.generated_url); } }, "Copy link") : null,
      published ? el("a", { class: "sp-btn small dark", href: x.generated_url, target: "_blank", rel: "noopener noreferrer", style: "text-decoration:none" }, "Open") : null);
  }

  /* ---------- pipeline ---------- */
  function api(path, opts) { return S.api(path, opts); }

  function pollAnalysis(documentId, onTick) {
    var started = Date.now();
    function attempt() {
      return api("/spikra/document/analyze", { method: "POST", json: { document_id: documentId }, timeoutMs: 120000 }).then(function (r) {
        if (!r.still_processing) return r;
        if (Date.now() - started > ANALYZE_MAX_MS) throw new S.ApiError(0, "TIMEOUT", "The AI analysis is taking longer than expected. Please try again in a few minutes.");
        onTick(Math.round((Date.now() - started) / 1000));
        return S.sleep(ANALYZE_POLL_MS).then(attempt);
      });
    }
    return attempt();
  }

  var STAGE_RUNNERS = {
    extract: function (r) { return api("/spikra/document/process", { method: "POST", query: { document_id: r.ids.document_id }, timeoutMs: 180000 }); },
    analyze: function (r, tick) { return pollAnalysis(r.ids.document_id, tick); },
    generate: function (r) { return api("/spikra/experience/generate", { method: "POST", query: { project_id: r.ids.project_id, document_id: r.ids.document_id }, timeoutMs: 240000 }); },
    publish: function (r) {
      return api("/spikra/experience/deploy", {
        method: "POST", timeoutMs: 180000,
        json: { experience_id: r.ids.experience_id, project_id: r.ids.project_id, document_id: r.ids.document_id, business_name: r.name }
      }).then(function (res) { r.url = res.generated_url || null; });
    }
  };
  var ORDER = ["extract", "analyze", "generate", "publish"];

  function runFrom(r, stage) {
    r.phase = "running"; r.error = null; renderRun();
    var idx = ORDER.indexOf(stage);
    (function next(i) {
      if (i >= ORDER.length) {
        r.phase = "done"; renderRun(); S.toast("Showcase published.", "ok"); loadList(true);
        return;
      }
      var id = ORDER[i];
      r.next = id; setStep(id, "active", id === "analyze" ? "This usually takes 1–3 minutes." : "");
      Promise.resolve(STAGE_RUNNERS[id](r, function (secs) { setStep("analyze", "active", "Still working… " + secs + "s elapsed"); }))
        .then(function () { setStep(id, "done", ""); next(i + 1); })
        .catch(function (e) { r.phase = "failed"; r.error = e.message; setStep(id, "failed", e.message); renderRun(); });
    })(idx);
  }

  var stepper = null;
  function setStep(id, state, text) {
    if (!stepper) return;
    if (state === "active") STEPS.forEach(function (s) { if (s.id !== id && ORDER.indexOf(s.id) < ORDER.indexOf(id)) stepper.set(s.id, "done"); });
    stepper.set(id, state, text);
  }

  function renderRun() {
    if (!run) return S.clear(ui.run);
    var box = el("div", { class: "sp-steps" });
    stepper = S.steps(box, STEPS);
    stepper.set("upload", "done", run.fileName || "");
    var reached = run.next ? ORDER.indexOf(run.next) : -1;
    ORDER.forEach(function (id, i) {
      if (run.phase === "done" || i < reached) stepper.set(id, "done");
      else if (i === reached) stepper.set(id, run.phase === "failed" ? "failed" : "active", run.phase === "failed" ? run.error : "");
    });

    var footer;
    if (run.phase === "done") {
      footer = el("div", { class: "sp-stack" },
        el("div", { class: "sp-banner ok" }, "Your showcase for " + run.name + " is live."),
        run.url ? el("div", { class: "sp-file" }, el("span", { class: "ico" }, "URL"), el("div", { class: "sp-grow sp-ellipsis", title: run.url }, run.url),
          el("button", { class: "sp-btn small", onclick: function () { S.copyText(run.url); } }, "Copy link"),
          el("a", { class: "sp-btn small dark", href: run.url, target: "_blank", rel: "noopener noreferrer", style: "text-decoration:none" }, "Open")) : null,
        el("button", { class: "sp-btn", onclick: function () { run = null; renderRun(); } }, "Dismiss"));
    } else if (run.phase === "failed") {
      footer = el("div", { class: "sp-stack" }, el("div", { class: "sp-banner err" }, run.error),
        el("div", { class: "sp-row" },
          el("button", { class: "sp-btn primary", onclick: function () { runFrom(run, run.next || "extract"); } }, "Retry this step"),
          el("button", { class: "sp-btn", onclick: function () { run = null; renderRun(); loadList(true); } }, "Dismiss")));
    } else {
      footer = el("div", { class: "sp-bar" }, el("span", { style: "width:" + Math.max(8, Math.round(((reached + 1) / ORDER.length) * 100)) + "%" }));
    }

    S.mount(ui.run, el("div", { class: "sp-card" },
      el("div", { class: "sp-card-head" }, el("h2", {}, "Creating “" + run.name + "”"), run.phase === "running" ? el("span", { class: "sp-spin dark" }) : null),
      el("div", { class: "sp-card-body sp-stack" }, box, footer)));
  }

  /* ---------- create form ---------- */
  function validate(vals) {
    var errs = {};
    if (!vals.business.trim()) errs.business = "Enter the customer’s business name.";
    else if (vals.business.length > 150) errs.business = "Keep it under 150 characters.";
    if (!vals.project.trim()) errs.project = "Enter a project name.";
    else if (vals.project.length > 255) errs.project = "Keep it under 255 characters.";
    if (vals.description.length > 5000) errs.description = "Keep it under 5,000 characters.";
    if (form.source === "computer" && !form.file) errs.doc = "Choose a PDF or Word document.";
    if (form.source === "workdrive" && !form.wdFile) errs.doc = "Pick a document from WorkDrive.";
    return errs;
  }

  function submit(vals) {
    var fd = new FormData();
    fd.append("business_name", vals.business.trim());
    fd.append("project_name", vals.project.trim());
    if (vals.description.trim()) fd.append("description", vals.description.trim());
    if (form.logo) fd.append("business_logo", form.logo, form.logo.name);
    var req = { method: "POST", body: fd, timeoutMs: 15 * 60 * 1000 };
    var fileName;
    if (form.source === "workdrive") { fd.append("workdrive_file_id", form.wdFile.id); req.auth = true; fileName = form.wdFile.name; }
    else { fd.append("document", form.file, form.file.name); fileName = form.file.name; }

    run = { phase: "running", name: vals.business.trim(), fileName: fileName, next: null, ids: null };
    renderRun(); setStepUploading();
    return api("/spikra/document/upload", req).then(function (r) {
      run.ids = { project_id: r.project_id, document_id: r.document_id, experience_id: r.experience_id };
      resetForm();
      runFrom(run, "extract");
    }).catch(function (e) { run = null; renderRun(); S.toast(e.message, "err", 7000); throw e; });
  }

  function setStepUploading() { if (stepper) stepper.set("upload", "active", "Uploading…"); }

  function resetForm() {
    if (form.logoUrl) URL.revokeObjectURL(form.logoUrl);
    form = { source: form.source, file: null, wdFile: null, logo: null, logoUrl: null };
    renderForm(true);
  }

  var fieldValues = { business: "", project: "", description: "" };

  function renderForm(clearValues) {
    if (clearValues) fieldValues = { business: "", project: "", description: "" };
    var errs = ui.errs || {};
    var busy = run && run.phase === "running";

    function field(key, label, node, hint) {
      return el("div", { class: "sp-field" }, el("label", {}, label), node, errs[key] ? el("div", { class: "err", role: "alert" }, errs[key]) : (hint ? el("div", { class: "hint" }, hint) : null));
    }
    function input(key, type, ph, max) {
      return el("input", { class: "sp-input" + (errs[key] ? " invalid" : ""), type: type, value: fieldValues[key], placeholder: ph, maxlength: max, disabled: busy,
        oninput: function (e) { fieldValues[key] = e.target.value; } });
    }

    var source = el("div", { class: "sp-tabs", role: "tablist" }, [["computer", "Upload from computer"], ["workdrive", "Pick from WorkDrive"]].map(function (t) {
      return el("button", { type: "button", class: "sp-tab", role: "tab", "aria-selected": String(form.source === t[0]), onclick: function () { form.source = t[0]; ui.errs = {}; renderForm(); } }, t[1]);
    }));

    var docArea;
    if (form.source === "computer") {
      docArea = form.file
        ? S.fileRow(form.file.name, S.fmtBytes(form.file.size), busy ? null : function () { form.file = null; renderForm(); })
        : S.dropzone({ accept: DOC_ACCEPT, label: "Drop your document here or click to browse", hint: "PDF or Word (.docx) · up to 99 MB",
          onFiles: function (files) {
            var f = files[0];
            if (DOC_ACCEPT.indexOf(S.extOf(f.name)) < 0) return S.toast("Only PDF and Word (.docx) documents are supported.", "err");
            if (f.size > MAX_DOC) return S.toast("That file is larger than 99 MB.", "err");
            if (!f.size) return S.toast("That file is empty.", "err");
            form.file = f; ui.errs = {}; renderForm();
          } });
    } else {
      docArea = form.wdFile
        ? S.fileRow(form.wdFile.name, S.fmtBytes(form.wdFile.size) + " · WorkDrive", busy ? null : function () { form.wdFile = null; renderForm(); })
        : el("button", { type: "button", class: "sp-btn", onclick: function () {
            S.pickFromWorkdrive({ multiple: false, accept: DOC_ACCEPT }).then(function (p) {
              if (!p || !p[0]) return;
              if (p[0].size > MAX_DOC) return S.toast("That file is larger than 99 MB.", "err");
              form.wdFile = p[0]; ui.errs = {}; renderForm();
            }, function (e) { S.toast(e.message, "err"); });
          } }, "Browse WorkDrive");
    }

    var logoArea = form.logo
      ? el("div", { class: "sp-file" }, el("img", { src: form.logoUrl, alt: "", style: "width:30px;height:30px;object-fit:contain;border-radius:6px" }),
        el("div", { class: "sp-grow sp-ellipsis" }, form.logo.name), el("button", { type: "button", class: "sp-btn small ghost danger", disabled: busy, onclick: function () { URL.revokeObjectURL(form.logoUrl); form.logo = null; form.logoUrl = null; renderForm(); } }, "Remove"))
      : S.dropzone({ accept: LOGO_ACCEPT, label: "Add the customer’s logo (optional)", hint: "PNG, JPG, WebP or SVG · up to 5 MB",
        onFiles: function (files) {
          var f = files[0];
          if (LOGO_ACCEPT.indexOf(S.extOf(f.name)) < 0) return S.toast("Logo must be PNG, JPG, WebP or SVG.", "err");
          if (f.size > MAX_LOGO) return S.toast("Logo must be under 5 MB.", "err");
          form.logo = f; form.logoUrl = URL.createObjectURL(f); renderForm();
        } });

    var button = el("button", { class: "sp-btn primary", type: "submit", disabled: busy }, busy ? [el("span", { class: "sp-spin" }), "Working…"] : "Create showcase");

    S.mount(ui.form, el("form", { class: "sp-card", novalidate: true, onsubmit: function (e) {
      e.preventDefault();
      if (busy) return;
      ui.errs = validate(fieldValues);
      if (Object.keys(ui.errs).length) { renderForm(); var bad = ui.form.querySelector(".invalid, .err"); if (bad && bad.scrollIntoView) bad.scrollIntoView({ block: "center" }); return; }
      submit(fieldValues).catch(function () { /* surfaced via toast */ });
    } },
      el("div", { class: "sp-card-head" }, el("h2", {}, "New customer showcase")),
      el("div", { class: "sp-card-body sp-stack" },
        field("business", "Business name", input("business", "text", "e.g. Acme Steel Pvt Ltd", 150)),
        field("project", "Project name", input("project", "text", "e.g. CRM & Marketing Automation", 255)),
        field("description", "Description (optional)", el("textarea", { class: "sp-textarea", maxlength: 5000, disabled: busy, placeholder: "Anything the AI should know about this customer or project",
          oninput: function (e) { fieldValues.description = e.target.value; } }, fieldValues.description)),
        el("div", { class: "sp-field" }, el("label", {}, "Document"), source, docArea, errs.doc ? el("div", { class: "err", role: "alert" }, errs.doc) : null),
        el("div", { class: "sp-field" }, el("label", {}, "Customer logo"), logoArea),
        button)));
  }

  /* ---------- boot ---------- */
  function start() {
    document.title = "Customer Showcases | Spikra";
    var widget = el("div");
    ui.form = el("div"); ui.run = el("div"); ui.list = el("div", { class: "sp-card" });
    S.mount(document.body, [
      el("header", { class: "sp-topbar" }, el("div", { class: "sp-brand" }, el("span", { class: "dot" }), "Spikra ", el("small", {}, "Customer Showcases")), widget),
      el("main", { class: "sp-shell" }, el("div", { class: "sp-grid" }, ui.form, el("div", { class: "sp-stack", style: "gap:24px" }, ui.run, ui.list)))
    ]);
    S.mountUserMenu(widget);
    renderForm(); renderRun(); renderList(); loadList();
    document.addEventListener("visibilitychange", function () { if (!document.hidden) scheduleRefresh(); });
  }

  if (window.ShowcaseViewer.wants()) window.ShowcaseViewer.start(); else S.boot(start);
})();
