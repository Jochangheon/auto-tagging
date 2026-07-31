/** Nearest page region landmark — code-collected factual signal for LLM. */

export type DomLandmark = "gnb" | "fnb" | "nav" | "main" | "content";



/** DOM parent-chain context for LLM category classification. */

export interface DomPathContext {

  dom_path: string;

  parent_labels?: string[];

  section_heading?: string | null;

  /** Nearest landmark region (header→gnb, footer→fnb, nav, main, else content). */

  landmark?: DomLandmark | null;

}



const LANDMARK_LABELS: Record<DomLandmark, string> = {

  gnb: "GNB(상단 헤더)",

  fnb: "Footer(하단 푸터)",

  nav: "내비게이션",

  main: "본문 콘텐츠",

  content: "일반 콘텐츠",

};



/** Infer landmark from dom_path string when live collection unavailable. */

export function inferLandmarkFromDomPath(dom_path: string): DomLandmark {

  if (!dom_path) return "content";

  if (/\bheader\b|\[role=banner\]/i.test(dom_path)) return "gnb";

  if (/\bfooter\b|\[role=contentinfo\]/i.test(dom_path)) return "fnb";

  if (/\bnav\b|\[role=navigation\]|\[role=menubar\]/i.test(dom_path)) return "nav";

  if (/\bmain\b/i.test(dom_path)) return "main";

  return "content";

}



/** Ensure landmark is set on a DomPathContext (mutates copy). */

export function withLandmark(ctx: DomPathContext | null | undefined): DomPathContext | undefined {

  if (!ctx?.dom_path) return ctx ?? undefined;

  if (ctx.landmark) return ctx;

  return { ...ctx, landmark: inferLandmarkFromDomPath(ctx.dom_path) };

}



/** Format dom_path fields for LLM candidate list lines. */

export function formatDomPathPromptFields(ctx?: DomPathContext | null): string {

  const enriched = withLandmark(ctx);

  if (!enriched?.dom_path) return "";

  const parts: string[] = [`dom_path="${enriched.dom_path}"`];

  if (enriched.landmark) {

    parts.push(`landmark="${enriched.landmark}(${LANDMARK_LABELS[enriched.landmark]})"`);

  }

  if (enriched.parent_labels?.length) {

    parts.push(`parent_labels="${enriched.parent_labels.join(", ")}"`);

  }

  if (enriched.section_heading) {

    parts.push(`section="${enriched.section_heading}"`);

  }

  return ` ${parts.join(" ")}`;

}



/** Browser-side dom_path extraction — injected into page.evaluate strings. */

export const BROWSER_DOM_PATH_FN = `

function __domIsStableToken(token) {

  if (!token) return false;

  if (/^[0-9]+$/.test(token)) return false;

  if (/^(ember|react|radix|headlessui|:r)/i.test(token)) return false;

  return token.length <= 48;

}



function __domShortText(el, max) {

  var t = (el.textContent || "").trim().replace(/\\s+/g, " ");

  return t.slice(0, max || 24);

}



function __domSegmentFor(el) {

  var tag = el.tagName.toLowerCase();

  var id = el.getAttribute("id");

  if (id && __domIsStableToken(id)) return tag + "#" + id.slice(0, 32);

  var aria = (el.getAttribute("aria-label") || "").trim();

  if (aria) return tag + "." + aria.replace(/\\s+/g, "").slice(0, 20);

  var role = el.getAttribute("role");

  if (role && ["navigation", "menu", "menubar", "banner", "contentinfo"].indexOf(role) >= 0) {

    return tag + "[role=" + role + "]";

  }

  var clsRaw = el.getAttribute("class") || "";

  var cls = clsRaw.split(/\\s+/).filter(function(c) {

    return c && !/^(css-|sc-|jsx-|_|chakra-|Mui|ant-)/.test(c);

  })[0];

  if (cls && __domIsStableToken(cls)) return tag + "." + cls.slice(0, 24);

  var txt = __domShortText(el, 16);

  if (txt && ["a", "button", "li", "span", "label", "summary"].indexOf(tag) >= 0) {

    return tag + "." + txt.replace(/[^\\w\\uAC00-\\uD7A3]+/g, "").slice(0, 16);

  }

  return tag;

}



function __domParentLabel(el) {

  var aria = (el.getAttribute("aria-label") || "").trim();

  if (aria) return aria.slice(0, 40);

  var tag = el.tagName.toLowerCase();

  var txt = __domShortText(el, 30);

  if (txt && ["nav", "header", "footer", "li", "button", "a"].indexOf(tag) >= 0) return txt;

  return "";

}



function __domDetectLandmark(el) {

  var inHeader = false;

  var inFooter = false;

  var inMain = false;

  var inNav = false;

  var inMobileNav = false;

  var cur = el;

  while (cur && cur !== document.body) {

    var tag = cur.tagName.toLowerCase();

    var role = (cur.getAttribute("role") || "").toLowerCase();

    var cls = (typeof cur.className === "string" ? cur.className : "").toLowerCase();

    var aria = (cur.getAttribute("aria-label") || "").toLowerCase();

    if (tag === "header" || role === "banner") inHeader = true;

    // Kanu PC chrome uses <div class="headerContainer"> — not <header>.
    if (/headercontainer|header-container|\bgnb\b|global-?nav/.test(cls)) inHeader = true;

    if (tag === "footer" || role === "contentinfo") inFooter = true;

    if (tag === "main") inMain = true;

    if (tag === "nav" || role === "navigation" || role === "menubar") inNav = true;

    // Mobile drawer / off-canvas menus usually sit outside <header>.
    if (
      role === "dialog" ||
      role === "menu" ||
      /drawer|side-?menu|offcanvas|mobile-?nav|m-nav|mo-nav|hamburger/.test(cls + " " + aria)
    ) {
      inMobileNav = true;
    }

    cur = cur.parentElement;

  }

  if (inHeader || inMobileNav) return "gnb";

  if (inFooter) return "fnb";

  if (inNav) return "nav";

  if (inMain) return "main";

  return "content";

}



function __domFindBannerSectionLabel(el) {

  var cur = el;

  while (cur && cur !== document.body) {

    if (cur.closest && cur.closest("header, nav")) break;

    var cls = String(cur.className || "").toLowerCase();

    var id = String(cur.id || "").toLowerCase();

    var blob = cls + " " + id;

    if (/swiper|carousel|slider|slick|splide|hero|main.?banner|rolling.?banner|visual.?banner|main.?visual/.test(blob)) {

      var aria = (cur.getAttribute("aria-label") || "").trim();

      if (/배너|banner|carousel|hero|visual|rolling/i.test(aria)) return aria.slice(0, 80);

      return "배너";

    }

    cur = cur.parentElement;

  }

  return null;

}



function __domFindSectionHeading(el) {

  var bannerLabel = __domFindBannerSectionLabel(el);

  if (bannerLabel) return bannerLabel;

  var cur = el;

  while (cur && cur !== document.body) {

    var tag = cur.tagName.toLowerCase();

    if (tag === "section" || tag === "main" || tag === "article" || tag === "aside") {

      var ariaSec = (cur.getAttribute("aria-label") || "").trim();

      if (ariaSec) return ariaSec.slice(0, 80);

      var h = cur.querySelector("h1,h2,h3,h4,h5,h6");

      if (h) {

        var ht = (h.textContent || "").trim().replace(/\\s+/g, " ");

        if (ht) return ht.slice(0, 80);

      }

    }

    cur = cur.parentElement;

  }

  var sib = el.previousElementSibling;

  var steps = 0;

  while (sib && steps < 5) {

    var st = sib.tagName.toLowerCase();

    if (/^h[1-6]$/.test(st)) {

      var ht2 = (sib.textContent || "").trim().replace(/\\s+/g, " ");

      if (ht2) return ht2.slice(0, 80);

    }

    if (sib.querySelector) {

      var h2 = sib.querySelector("h1,h2,h3,h4,h5,h6");

      if (h2) {

        var ht3 = (h2.textContent || "").trim().replace(/\\s+/g, " ");

        if (ht3) return ht3.slice(0, 80);

      }

    }

    sib = sib.previousElementSibling;

    steps++;

  }

  return null;

}



function extractDomPathContext(el) {

  var chain = [];

  var labels = [];

  var cur = el;

  var depth = 0;

  var MAX_DEPTH = 10;

  var SKIP_TAGS = { html: 1, body: 1, div: 1, span: 1 };



  while (cur && cur !== document.documentElement && depth < MAX_DEPTH) {

    var tag = cur.tagName.toLowerCase();

    var isRegion = ["header", "nav", "footer", "main", "section", "aside", "form", "ul", "ol", "li", "menu"].indexOf(tag) >= 0;

    var hasId = cur.id && __domIsStableToken(cur.id);

    var hasRole = cur.getAttribute("role");

    if (isRegion || hasId || hasRole || !SKIP_TAGS[tag] || depth === 0) {

      chain.unshift(__domSegmentFor(cur));

      var pl = __domParentLabel(cur);

      if (pl && labels.indexOf(pl) < 0) labels.unshift(pl);

    }

    cur = cur.parentElement;

    depth++;

  }



  return {

    dom_path: chain.join(">"),

    parent_labels: labels.slice(0, 6),

    section_heading: __domFindSectionHeading(el) || null,

    landmark: __domDetectLandmark(el),

  };

}

`.trim();

