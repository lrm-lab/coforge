export const PAGE_RUNTIME_PATH = "/_coforge/runtime.js";

const RUNTIME_SOURCE = `(function () {
"use strict";
var script = document.currentScript;
var hostOrigin = script ? script.getAttribute("data-host") : null;
var framed = Boolean(hostOrigin) && window.parent !== window;
var WEBRTC = ["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCSessionDescription","RTCIceCandidate","RTCIceTransport","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver","RTCDtlsTransport","RTCSctpTransport","RTCCertificate"];
WEBRTC.forEach(function (name) {
  try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }); } catch (error) {}
});
if (window.navigation && window.navigation.addEventListener) {
  window.navigation.addEventListener("navigate", function (event) {
    try {
      if (event.cancelable && new URL(event.destination.url).origin !== location.origin) event.preventDefault();
    } catch (error) {}
  });
}
function post(message) {
  message.jsonrpc = "2.0";
  window.parent.postMessage(message, hostOrigin);
}
var pending = new Map();
var nextId = 1;
function request(method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var id = nextId++;
    var timer = setTimeout(function () {
      pending.delete(id);
      reject(new Error("The host did not answer"));
    }, timeoutMs || 15000);
    pending.set(id, { resolve: resolve, reject: reject, timer: timer });
    post({ id: id, method: method, params: params });
  });
}
function applyTheme(theme) {
  if (theme !== "light" && theme !== "dark") return;
  document.documentElement.setAttribute("data-theme", theme);
  window.dispatchEvent(new CustomEvent("coforge:theme", { detail: { theme: theme } }));
}
var overlay = null;
var shadow = null;
var ranges = [];
var activeIndex = 0;
var findQuery = "";
function overlayRoot() {
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483647";
    shadow = overlay.attachShadow({ mode: "closed" });
    document.documentElement.appendChild(overlay);
  }
  return shadow;
}
function collectRanges(query) {
  var found = [];
  if (!query || !document.body) return found;
  var needle = query.toLowerCase();
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var node;
  while ((node = walker.nextNode()) && found.length < 500) {
    var parent = node.parentElement;
    if (!parent || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(parent.tagName)) continue;
    var text = node.nodeValue.toLowerCase();
    var from = 0;
    var at;
    while ((at = text.indexOf(needle, from)) >= 0 && found.length < 500) {
      var range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      if (range.getClientRects().length > 0) found.push(range);
      from = at + needle.length;
    }
  }
  return found;
}
function drawMatches() {
  var root = overlayRoot();
  root.textContent = "";
  ranges.forEach(function (range, index) {
    var current = index === activeIndex;
    Array.prototype.forEach.call(range.getClientRects(), function (rect) {
      var box = document.createElement("div");
      box.style.cssText = "position:absolute;border-radius:2px;left:" + (rect.left + window.scrollX) + "px;top:" + (rect.top + window.scrollY) + "px;width:" + rect.width + "px;height:" + rect.height + "px;background:" + (current ? "rgba(255,149,0,.55)" : "rgba(255,214,10,.4)") + ";outline:" + (current ? "2px solid #ff9500" : "none");
      root.appendChild(box);
    });
  });
}
function reportFind() {
  post({ method: "coforge/notifications/find-result", params: { total: ranges.length, active: ranges.length ? activeIndex + 1 : 0 } });
}
function find(params) {
  var query = params && typeof params.query === "string" ? params.query.slice(0, 200) : "";
  var step = params && Number.isInteger(params.step) ? params.step : 0;
  if (query !== findQuery || step === 0) {
    findQuery = query;
    ranges = collectRanges(query);
    activeIndex = 0;
  } else if (ranges.length) {
    activeIndex = (activeIndex + step + ranges.length) % ranges.length;
  }
  drawMatches();
  var active = ranges[activeIndex];
  if (active) {
    var rect = active.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) window.scrollTo({ top: rect.top + window.scrollY - window.innerHeight / 3, behavior: "instant" });
    drawMatches();
  }
  reportFind();
}
window.addEventListener("resize", function () {
  if (ranges.length) drawMatches();
});
var offer = null;
var handshake = null;
function connect() {
  if (!framed) return Promise.resolve(null);
  if (!handshake) {
    handshake = request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "coforge-page", version: "1" }, appCapabilities: {} }, 3000).then(function (result) {
      var context = result && result.hostContext;
      if (context) applyTheme(context.theme);
      post({ method: "ui/notifications/initialized" });
      offer = result && result.experimental && result.experimental["coforge/runtime"];
      return offer && Array.isArray(offer.namespaces) ? offer : null;
    }).catch(function () { return null; });
  }
  return handshake;
}
function call(namespace, method, args, confirmed) {
  return request("coforge/call", { namespace: namespace, method: method, args: args }, confirmed ? 120000 : 15000);
}
var watchers = new Map();
var nextWatch = 1;
function assetBase() {
  var own = /^\\/_f\\/([^/]+)\\//.exec(location.pathname);
  return own ? location.origin + "/_a/" + own[1] + "/" : null;
}
function assetView(item) {
  var base = assetBase();
  return { name: item.name, sizeBytes: item.sizeBytes, contentType: item.contentType, url: base ? base + encodeURIComponent(item.name) : null };
}
function writeOptions(options) {
  return options && options.ifVersion !== undefined ? options.ifVersion : undefined;
}
var namespaces = {
  user: function () { return { get: function () { return call("user", "get"); } }; },
  artifact: function () { return { get: function () { return call("artifact", "get"); } }; },
  clipboard: function () { return { copy: function (text) { return call("clipboard", "copy", { text: String(text) }); } }; },
  links: function () { return { open: function (url) { return request("ui/open-link", { url: String(url) }); } }; },
  comments: function () { return { open: function (options) { return call("comments", "open", options || {}); } }; },
  db: function () {
    return {
      get: function (collection, id) { return call("db", "get", { collection: String(collection), id: String(id) }); },
      query: function (collection, query) { return call("db", "query", { collection: String(collection), query: query }); },
      set: function (collection, id, data, options) { return call("db", "set", { collection: String(collection), id: String(id), data: data, ifVersion: writeOptions(options) }, true); },
      update: function (collection, id, data, options) { return call("db", "update", { collection: String(collection), id: String(id), data: data, ifVersion: writeOptions(options) }, true); },
      delete: function (collection, id, options) { return call("db", "delete", { collection: String(collection), id: String(id), ifVersion: writeOptions(options) }, true); },
      batch: function (ops) { return call("db", "batch", { ops: ops }, true); },
      watch: function (collection, queryOrCallback, maybeCallback) {
        var callback = typeof queryOrCallback === "function" ? queryOrCallback : maybeCallback;
        var query = typeof queryOrCallback === "function" ? undefined : queryOrCallback;
        if (typeof callback !== "function") return Promise.reject(new TypeError("watch needs a callback"));
        var id = "w" + nextWatch++;
        watchers.set(id, callback);
        return call("db", "watch", { id: id, collection: String(collection), query: query }).then(function () {
          return function stop() {
            watchers.delete(id);
            call("db", "unwatch", { id: id }).catch(function () {});
          };
        }, function (error) {
          watchers.delete(id);
          throw error;
        });
      }
    };
  },
  assets: function () {
    return {
      list: function () { return call("assets", "list").then(function (items) { return items.map(assetView); }); },
      url: function (name) {
        var base = assetBase();
        if (!base) throw new Error("This page has no asset library here");
        return base + encodeURIComponent(String(name));
      },
      upload: function (file, name) { return call("assets", "upload", { file: file, name: name }, true).then(assetView); },
      delete: function (name) { return call("assets", "delete", { name: String(name) }, true); }
    };
  }
};
var apis = {};
function use(namespace) {
  return connect().then(function (granted) {
    if (!granted || granted.namespaces.indexOf(namespace) < 0 || !namespaces[namespace]) return null;
    if (!apis[namespace]) apis[namespace] = Object.freeze(namespaces[namespace]());
    return apis[namespace];
  });
}
Object.defineProperty(window, "coforge", { value: Object.freeze({ use: use }), writable: false, configurable: false });
if (framed) {
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || event.origin !== hostOrigin) return;
    var message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.method === undefined && message.id !== undefined) {
      var waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(String(message.error.message || "Refused")));
      else waiting.resolve(message.result);
    } else if (message.method === "ui/notifications/host-context-changed") {
      applyTheme(message.params && message.params.theme);
    } else if (message.method === "coforge/find") {
      find(message.params);
    } else if (message.method === "coforge/watch" && message.params) {
      var watcher = watchers.get(message.params.id);
      if (watcher) {
        try {
          if (message.params.error) watcher(null, new Error(String(message.params.error)));
          else watcher(message.params.result, null);
        } catch (error) {
          setTimeout(function () { throw error; });
        }
      }
    }
  });
  var errors = 0;
  var report = function (text) {
    if (errors >= 5) return;
    errors += 1;
    post({ method: "coforge/notifications/error", params: { message: String(text).slice(0, 500) } });
  };
  window.addEventListener("error", function (event) { report(event.message || "Script error"); });
  window.addEventListener("unhandledrejection", function (event) {
    report(event.reason && event.reason.message ? event.reason.message : String(event.reason));
  });
  var scheduled = false;
  var observer = new ResizeObserver(function () {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      post({ method: "ui/notifications/size-changed", params: { width: Math.ceil(document.documentElement.scrollWidth), height: Math.ceil(document.documentElement.scrollHeight) } });
    });
  });
  observer.observe(document.documentElement);
  connect();
}
})();
`;

export const pageRuntimeSource = (): string => RUNTIME_SOURCE;

const encoder = new TextEncoder();

export function withPageRuntime(
  page: Uint8Array,
  hostOrigin: string | null,
): Uint8Array<ArrayBuffer> {
  const attribute = hostOrigin ? ` data-host="${hostOrigin}"` : "";
  const tag = encoder.encode(`<script src="${PAGE_RUNTIME_PATH}"${attribute}></script>`);
  const head = new TextDecoder("utf-8", { ignoreBOM: true }).decode(page.subarray(0, 1024));
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(head)?.[0];
  const at = doctype ? encoder.encode(doctype).byteLength : 0;
  const out = new Uint8Array(page.byteLength + tag.byteLength);
  out.set(page.subarray(0, at), 0);
  out.set(tag, at);
  out.set(page.subarray(at), at + tag.byteLength);
  return out;
}
