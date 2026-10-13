/* Minimal helpers for the public share-link viewers. No sign-in and no dependencies.
 * Requires window.SPIKRA_CONFIG = { apiBase } from each app's config.js.
 * Server-provided text is only ever written with textContent, never innerHTML. */
(function (global) {
  "use strict";

  var API_BASE = String((global.SPIKRA_CONFIG || {}).apiBase || "").replace(/\/+$/, "");
  var V = {};

  function ViewerError(message) {
    var err = new Error(message);
    err.name = "ViewerError";
    return err;
  }

  V.el = function (tag, attrs) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.slice(0, 2) === "on" && typeof value === "function") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    });
    Array.prototype.slice.call(arguments, 2).forEach(function (kid) {
      if (kid === null || kid === undefined || kid === false) return;
      node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    });
    return node;
  };

  V.mount = function (node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    Array.prototype.slice.call(arguments, 1).forEach(function (kid) { if (kid) node.appendChild(kid); });
    return node;
  };

  V.showLoading = function () {
    V.mount(document.body, V.el("div", { class: "sp-fullpage" },
      V.el("span", { class: "sp-spin dark", style: "width:40px;height:40px;border-width:3px" }),
      V.el("p", { class: "sp-muted" }, "Loading…")));
  };

  V.showMessage = function (title, message, actionLabel, onAction) {
    V.mount(document.body, V.el("div", { class: "sp-fullpage" },
      V.el("h1", {}, title),
      V.el("p", { class: "sp-muted", style: "max-width:460px" }, message),
      actionLabel ? V.el("button", { class: "sp-btn dark", onclick: onAction }, actionLabel) : null));
  };

  /* Fetches a server-rendered document (HTML) from the public API. */
  V.fetchDocument = function (path, query) {
    if (!API_BASE) return Promise.reject(ViewerError("This page is not configured: config.js must set SPIKRA_CONFIG.apiBase."));
    var qs = new URLSearchParams();
    Object.keys(query || {}).forEach(function (k) { if (query[k]) qs.set(k, query[k]); });
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 30000);
    return fetch(API_BASE + path + "?" + qs.toString(), { signal: controller.signal, credentials: "omit" })
      .catch(function (e) {
        throw ViewerError(e && e.name === "AbortError" ? "Loading timed out." : "Could not reach the server.");
      })
      .then(function (res) {
        clearTimeout(timer);
        return res.text().then(function (text) {
          if (!res.ok || !text) {
            throw ViewerError(res.status === 404 ? "This link could not be found. It may have been removed." : "The server returned an error (HTTP " + res.status + ").");
          }
          return text;
        });
      });
  };

  /* Shows generated HTML in a full-screen frame that cannot navigate the top page. */
  V.renderDocumentFrame = function (html, title) {
    var frame = V.el("iframe", {
      class: "sp-frame", title: title || "Document",
      sandbox: "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-forms"
    });
    V.mount(document.body, frame);
    frame.srcdoc = html;
  };

  V.Error = ViewerError;
  global.SpikraViewer = V;
})(window);
