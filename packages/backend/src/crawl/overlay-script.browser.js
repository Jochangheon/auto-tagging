/**

 * Pure browser script — loaded as string for page.evaluate (no TS/esbuild __name).

 * Must define: function __autotagHighlight(input) { ... return result; }

 */

function __autotagHighlight(input) {

  var LAYER_ID = "__autotag_live_highlight__";

  var tagId = input && input.tagId != null ? input.tagId : null;

  var label = input && input.label != null ? input.label : null;

  var selectorHint = input && input.selectorHint ? input.selectorHint : null;

  var selectorsFallback = (input && input.selectorsFallback) || [];

  var overlayBbox = input && input.overlayBbox ? input.overlayBbox : null;

  var multiTargets = (input && input.targets) || null;



  function waitMs(ms) {

    var start = Date.now();

    while (Date.now() - start < ms) { /* sync wait in evaluate */ }

  }



  function clearLayer() {

    var existing = document.getElementById(LAYER_ID);

    if (existing) existing.remove();

    if (window.__autotagHighlightCleanup) {

      try { window.__autotagHighlightCleanup(); } catch (e0) {}

      window.__autotagHighlightCleanup = null;

    }

  }



  function resolveElementFor(sub) {

    var tid = sub && sub.tagId != null ? sub.tagId : tagId;

    var hint = sub && sub.selectorHint ? sub.selectorHint : selectorHint;

    var fallbacks = (sub && sub.selectorsFallback) || selectorsFallback;



    if (tid != null && isFinite(Number(tid))) {

      var byTag = document.querySelector('[data-tag-id="' + tid + '"]');

      if (byTag) {

        return { el: byTag, method: "tag_id", sel: '[data-tag-id="' + tid + '"]' };

      }

    }



    var hintStr = hint && String(hint).trim();

    if (hintStr) {

      try {

        var foundHint = document.querySelector(hintStr);

        if (foundHint) return { el: foundHint, method: "selector_hint", sel: hintStr };

      } catch (e) {}

    }



    for (var i = 0; i < fallbacks.length; i++) {

      var sel = fallbacks[i] && String(fallbacks[i]).trim();

      if (!sel) continue;

      try {

        var foundFb = document.querySelector(sel);

        if (foundFb) return { el: foundFb, method: "fallback", sel: sel };

      } catch (e2) {}

    }



    return { el: null, method: "none", sel: null };

  }



  function resolveElement() {

    return resolveElementFor(null);

  }



  function isVisible(el) {

    if (!el || !(el instanceof HTMLElement)) return false;

    if (!el.isConnected) return false;

    var style = window.getComputedStyle(el);

    if (style.display === "none" || style.visibility === "hidden") return false;

    if (parseFloat(style.opacity || "1") === 0) return false;

    var rect = el.getBoundingClientRect();

    if (rect.width <= 0 && rect.height <= 0) return false;

    return true;

  }



  function classifyHiddenReason(el) {

    if (!el || !(el instanceof HTMLElement)) return "not_found";

    var style = window.getComputedStyle(el);

    if (style.display === "none") return "display_none";

    if (style.visibility === "hidden") return "visibility_hidden";

    if (parseFloat(style.opacity || "1") === 0) return "opacity_zero";

    var rect = el.getBoundingClientRect();

    if (rect.width <= 0 && rect.height <= 0) return "zero_size";

    var cur = el.parentElement;

    while (cur && cur !== document.body) {

      var ps = window.getComputedStyle(cur);

      if (ps.display === "none" || cur.hasAttribute("hidden") || ps.visibility === "hidden") {

        return "collapsed_parent";

      }

      cur = cur.parentElement;

    }

    return "hidden";

  }



  function tryRevealHidden(el) {

    if (!el || !(el instanceof HTMLElement)) return { revealed: false, reason: "not_found" };

    if (isVisible(el)) return { revealed: true, reason: null };



    var parents = [];

    var cur = el.parentElement;

    while (cur && cur !== document.body) {

      parents.push(cur);

      cur = cur.parentElement;

    }

    parents.reverse();



    for (var ci = 0; ci < parents.length; ci++) {

      var parent = parents[ci];

      var role = parent.getAttribute("role");

      var ariaExpanded = parent.getAttribute("aria-expanded");

      var isTrigger =

        role === "button" ||

        ariaExpanded === "false" ||

        parent.tagName === "BUTTON" ||

        parent.hasAttribute("data-toggle") ||

        parent.hasAttribute("aria-haspopup") ||

        parent.classList.contains("dropdown") ||

        parent.classList.contains("menu");

      if (!isTrigger && ariaExpanded !== "false") continue;

      try { parent.click(); } catch (e4) {}

      waitMs(120);

      if (isVisible(el)) return { revealed: true, reason: null };

    }



    return { revealed: false, reason: classifyHiddenReason(el) };

  }



  function scrollToTarget(el) {

    if (el && el instanceof HTMLElement) {

      try {

        el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });

      } catch (e6) {}

      void el.offsetHeight;

      waitMs(450);

      var rect = el.getBoundingClientRect();

      var offscreen =

        rect.bottom < 0 ||

        rect.top > window.innerHeight ||

        rect.right < 0 ||

        rect.left > window.innerWidth;

      if (offscreen) {

        try {

          el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });

        } catch (e7) {}

        waitMs(200);

      }

    }

  }



  function measureDocumentBbox(el) {

    if (el && el instanceof HTMLElement) {

      var rect = el.getBoundingClientRect();

      if (rect.width > 0 || rect.height > 0) {

        return {

          x: Math.round(rect.x + window.scrollX),

          y: Math.round(rect.y + window.scrollY),

          w: Math.round(rect.width),

          h: Math.round(rect.height),

        };

      }

    }

    return null;

  }



  function viewportRect(el, bbox) {

    if (el && el instanceof HTMLElement) {

      var rect = el.getBoundingClientRect();

      if (rect.width > 0 || rect.height > 0) return rect;

    }

    if (bbox && bbox.w > 0 && bbox.h > 0) {

      return {

        left: bbox.x - window.scrollX,

        top: bbox.y - window.scrollY,

        width: bbox.w,

        height: bbox.h,

        right: bbox.x - window.scrollX + bbox.w,

        bottom: bbox.y - window.scrollY + bbox.h,

      };

    }

    return null;

  }



  function failResult(method, sel, reason) {

    return {

      ok: false,

      status: "위치 확인 불가",

      reason: reason || "not_found",

      method: method,

      resolved_selector: sel,

    };

  }



  clearLayer();



  if (multiTargets && multiTargets.length > 0) {

    var resolvedList = [];

    for (var ti = 0; ti < multiTargets.length; ti++) {

      var sub = multiTargets[ti];

      var rr = resolveElementFor(sub);

      if (!rr.el) continue;

      var rev = tryRevealHidden(rr.el);

      if (!rev.revealed) continue;

      resolvedList.push({ el: rr.el, method: rr.method, sel: rr.sel, tagId: sub.tagId });

    }

    if (!resolvedList.length) {

      return failResult("none", null, "not_found");

    }

    scrollToTarget(resolvedList[0].el);



    var multiLayer = document.createElement("div");

    multiLayer.id = LAYER_ID;

    multiLayer.setAttribute("data-autotag", "live-highlight");

    multiLayer.style.position = "fixed";

    multiLayer.style.inset = "0";

    multiLayer.style.pointerEvents = "none";

    multiLayer.style.zIndex = "2147483646";

    multiLayer.style.overflow = "hidden";

    document.documentElement.appendChild(multiLayer);



    function repaintMulti() {

      while (multiLayer.firstChild) multiLayer.removeChild(multiLayer.firstChild);

      var anyVisible = false;

      for (var ri = 0; ri < resolvedList.length; ri++) {

        var item = resolvedList[ri];

        if (!item.el || !item.el.isConnected) continue;

        var liveBbox = measureDocumentBbox(item.el);

        var liveRect = viewportRect(item.el, liveBbox);

        if (!liveRect || (liveRect.width <= 0 && liveRect.height <= 0)) continue;

        anyVisible = true;

        var box = document.createElement("div");

        box.style.position = "absolute";

        box.style.left = liveRect.left + "px";

        box.style.top = liveRect.top + "px";

        box.style.width = liveRect.width + "px";

        box.style.height = liveRect.height + "px";

        box.style.border = "3px solid #6366F1";

        box.style.background = "rgba(99, 102, 241, 0.15)";

        box.style.boxSizing = "border-box";

        box.style.borderRadius = "4px";

        box.style.boxShadow = "0 0 0 1px rgba(255,255,255,0.6)";

        multiLayer.appendChild(box);



        if (item.tagId != null) {

          var idEl = document.createElement("div");

          idEl.textContent = String(item.tagId);

          idEl.style.position = "absolute";

          idEl.style.left = Math.max(4, liveRect.left) + "px";

          idEl.style.top = Math.max(4, liveRect.top - 22) + "px";

          idEl.style.padding = "2px 6px";

          idEl.style.background = "#6366F1";

          idEl.style.color = "#fff";

          idEl.style.fontSize = "11px";

          idEl.style.fontFamily = "system-ui, sans-serif";

          idEl.style.borderRadius = "3px";

          multiLayer.appendChild(idEl);

        }

      }

      if (!anyVisible) clearLayer();

    }



    try {

      repaintMulti();

    } catch (eMulti) {

      clearLayer();

      return failResult("none", null, "overlay_failed");

    }



    var onMoveMulti = function () { repaintMulti(); };

    window.addEventListener("scroll", onMoveMulti, true);

    window.addEventListener("resize", onMoveMulti);

    window.__autotagHighlightCleanup = function () {

      window.removeEventListener("scroll", onMoveMulti, true);

      window.removeEventListener("resize", onMoveMulti);

    };



    return {

      ok: true,

      status: "highlighted",

      method: "tag_id",

      resolved_selector: null,

      highlighted_count: resolvedList.length,

    };

  }



  var resolved = resolveElement();

  var el = resolved.el;

  var method = resolved.method;

  var sel = resolved.sel;



  if (method === "none" || !el) {

    return failResult("none", sel, "not_found");

  }



  var target = el;

  var reveal = tryRevealHidden(target);

  if (!reveal.revealed) {

    return failResult(method, sel, reveal.reason || "hidden");

  }



  scrollToTarget(target);



  var bbox = measureDocumentBbox(target);

  if (!bbox || (bbox.w <= 0 && bbox.h <= 0)) {

    return failResult(method, sel, classifyHiddenReason(target));

  }



  var rect = viewportRect(target, bbox);

  if (!rect || (rect.width <= 0 && rect.height <= 0)) {

    return failResult(method, sel, classifyHiddenReason(target));

  }



  var layer = document.createElement("div");

  layer.id = LAYER_ID;

  layer.setAttribute("data-autotag", "live-highlight");

  layer.style.position = "fixed";

  layer.style.inset = "0";

  layer.style.pointerEvents = "none";

  layer.style.zIndex = "2147483646";

  layer.style.overflow = "hidden";

  document.documentElement.appendChild(layer);



  function repaint() {

    var liveBbox = measureDocumentBbox(target);

    var liveRect = viewportRect(target, liveBbox);

    if (!liveRect) {

      clearLayer();

      return;

    }

    if (target && !target.isConnected) {

      clearLayer();

      return;

    }

    while (layer.firstChild) layer.removeChild(layer.firstChild);

    if (liveRect.width <= 0 && liveRect.height <= 0) return;



    var box = document.createElement("div");

    box.style.position = "absolute";

    box.style.left = liveRect.left + "px";

    box.style.top = liveRect.top + "px";

    box.style.width = liveRect.width + "px";

    box.style.height = liveRect.height + "px";

    box.style.border = "3px solid #6366F1";

    box.style.background = "rgba(99, 102, 241, 0.15)";

    box.style.boxSizing = "border-box";

    box.style.borderRadius = "4px";

    box.style.boxShadow = "0 0 0 1px rgba(255,255,255,0.6)";

    layer.appendChild(box);



    if (label) {

      var tagEl = document.createElement("div");

      tagEl.textContent = label;

      tagEl.style.position = "absolute";

      tagEl.style.left = Math.max(4, liveRect.left) + "px";

      tagEl.style.top = Math.max(4, liveRect.top - 28) + "px";

      tagEl.style.padding = "4px 8px";

      tagEl.style.background = "#6366F1";

      tagEl.style.color = "#fff";

      tagEl.style.fontSize = "12px";

      tagEl.style.fontFamily = "system-ui, sans-serif";

      tagEl.style.borderRadius = "4px";

      tagEl.style.maxWidth = "280px";

      tagEl.style.overflow = "hidden";

      tagEl.style.textOverflow = "ellipsis";

      tagEl.style.whiteSpace = "nowrap";

      layer.appendChild(tagEl);

    }

  }



  try {

    repaint();

  } catch (e7) {

    clearLayer();

    return failResult(method, sel, "overlay_failed");

  }



  var onMove = function () { repaint(); };

  window.addEventListener("scroll", onMove, true);

  window.addEventListener("resize", onMove);

  window.__autotagHighlightCleanup = function () {

    window.removeEventListener("scroll", onMove, true);

    window.removeEventListener("resize", onMove);

  };



  return {

    ok: true,

    status: "highlighted",

    method: method,

    resolved_selector: sel,

  };

}

