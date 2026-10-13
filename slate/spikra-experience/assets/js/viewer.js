/* Public showcase viewer (no sign-in): /?slug=<slug>&experience_id=<id>&project_id=<id>, or /<slug> via 404.html. */
(function () {
  "use strict";
  var V = window.SpikraViewer;

  function parseRoute() {
    var params = new URLSearchParams(window.location.search);
    var hash = (window.location.hash || "").replace(/^[#/]+|[#/]+$/g, "");
    var hashParams = hash.indexOf("=") >= 0 ? new URLSearchParams(hash) : null;
    var pathSlug = (window.location.pathname || "").replace(/^\/+|\/+$/g, "");
    if (/^(index|404)\.html$/i.test(pathSlug)) pathSlug = "";

    return {
      slug: params.get("slug") || (hashParams && hashParams.get("slug")) || (hash && !hashParams ? hash : "") || pathSlug,
      experienceId: params.get("experience_id") || params.get("id") || (hashParams && (hashParams.get("experience_id") || hashParams.get("id"))) || "",
      projectId: params.get("project_id") || ""
    };
  }

  function titleFromSlug(slug) {
    var words = String(slug || "").replace(/_proposal$/i, "").replace(/[-_]+/g, " ").trim().split(" ").filter(Boolean);
    return words.map(function (w) {
      var l = w.toLowerCase();
      if (["and", "of", "the"].indexOf(l) >= 0) return l;
      return w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + l.slice(1);
    }).join(" ");
  }

  var route = parseRoute();
  document.title = titleFromSlug(route.slug) || "Customer Showcase";

  if (!route.slug && !route.experienceId) {
    V.showMessage("No showcase selected", "This link is incomplete. Use the link provided by your Spikra representative.");
    return;
  }
  if (route.slug && window.location.search.indexOf("slug=") < 0 && window.history && history.replaceState) {
    try { history.replaceState(null, "", "/?slug=" + encodeURIComponent(route.slug) + (route.experienceId ? "&experience_id=" + encodeURIComponent(route.experienceId) : "")); } catch (e) { /* cosmetic only */ }
  }

  V.showLoading();
  V.fetchDocument("/spikra/experience/deploy", { slug: route.slug, experience_id: route.experienceId, project_id: route.projectId })
    .then(function (html) {
      var trimmed = html.trim();
      if (trimmed.charAt(0) === "{") {
        var msg = "This showcase could not be retrieved.";
        try { var parsed = JSON.parse(trimmed); if (parsed && parsed.message) msg = parsed.message; } catch (e) { /* keep default */ }
        throw new V.Error(msg);
      }
      V.renderDocumentFrame(html, "Spikra Customer Showcase");
    })
    .catch(function (e) { V.showMessage("Showcase not available", e.message, "Try again", function () { window.location.reload(); }); });
})();
