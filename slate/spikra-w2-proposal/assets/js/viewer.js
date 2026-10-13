/* Public proposal viewer: /?proposal_id=<id>&type=<technical|commercial|tos> (or the path forms). */
(function () {
  "use strict";
  var S = window.Spikra;
  var DOC_TYPES = ["technical", "commercial", "tos"];

  function parseRoute() {
    var params = new URLSearchParams(window.location.search);
    var id = params.get("proposal_id") || params.get("id") || "";
    var type = params.get("type") || params.get("doc") || "";
    if (!id) {
      var seg = (window.location.pathname || "").split("/").filter(Boolean);
      var low = seg.map(function (s) { return s.toLowerCase(); });
      if (low[0] === "proposal" && seg.length >= 2) { id = seg[1]; type = type || seg[2] || ""; }
      else if (seg.length >= 2 && DOC_TYPES.indexOf(low[0]) >= 0) { type = type || seg[0]; id = seg[1]; }
      else if (seg.length >= 2 && DOC_TYPES.indexOf(low[1]) >= 0) { id = seg[0]; type = type || seg[1]; }
      else if (seg.length === 1 && low[0] !== "index.html" && low[0] !== "404.html") { id = seg[0]; }
    }
    type = String(type || "commercial").toLowerCase();
    return { id: id, type: DOC_TYPES.indexOf(type) >= 0 ? type : "commercial" };
  }

  window.W2Viewer = {
    wants: function () { return !!parseRoute().id; },
    start: function () {
      var route = parseRoute();
      document.title = "Solution Proposal | Spikra";
      S.mount(document.body, S.el("div", { class: "sp-fullpage" },
        S.el("span", { class: "sp-spin dark", style: "width:40px;height:40px;border-width:3px" }),
        S.el("p", { class: "sp-muted" }, "Loading proposal…")));

      S.fetchDocument("/proposal/api", { resource: "view", proposal_id: route.id, type: route.type })
        .then(function (html) { S.renderDocumentFrame(html, "Spikra Solution Proposal"); })
        .catch(function (e) {
          S.fullpageMessage("Unable to load proposal", e.message, "Try again", function () { window.location.reload(); });
        });
    }
  };
})();
