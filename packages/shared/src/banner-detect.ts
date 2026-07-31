import type { DomPathContext } from "./dom-path.js";
import type { SnapshotCandidate, SnapshotSuggestion } from "./snapshot-pipeline.js";
import { normalizeCategoryDisplay } from "./candidate-link-dedup.js";

/** Hero / main carousel containers — dom_path hint for LLM. */
export const BANNER_DOM_HINT_RE =
  /swiper|carousel|slider|slick|splide|hero[-_]?banner|main[-_]?banner|rolling[-_]?banner|visual[-_]?banner|main[-_]?visual|배너/i;

export const BANNER_SECTION_HEADING_RE =
  /^(메인\s*)?배너|main\s*banner|hero\s*banner|visual\s*banner|rolling\s*banner|캐러셀|슬라이드|carousel|slider|swiper/i;

/** Product/recommendation swipers are NOT content banners (category hint only). */
export const NON_BANNER_SECTION_RE =
  /추천|상품|product|recommend|card|wish|장바구니|혜택|프로모션|이벤트\s*배너/i;

/** Extra interactive targets inside carousels (additive — never used to skip other elements). */
export const BANNER_SLIDE_SELECTOR =
  "[class*='main-banner-swiper'] .swiper-slide, [class*='main-banner'] .swiper-slide, [class*='hero-banner'] .swiper-slide, [class*='rolling-banner'] .swiper-slide, [class*='visual-banner'] .swiper-slide, [class*='main-visual'] .swiper-slide";

export const BANNER_INTERACTIVE_SELECTOR =
  BANNER_SLIDE_SELECTOR +
  ", [class*='deal-carousel'] a, [class*='carousel'] a[class*='btn'], [class*='carousel'] a[class*='button'], [class*='swiper-button'], .swiper-pagination-bullet, [class*='swiper-pagination'] button, [class*='swiper-pagination'] [role='button'], [class*='carousel'] button, [class*='carousel'] a[href], [class*='slider'] button, [class*='slider'] a[href], [class*='slick-'] button, [class*='splide'] button, [class*='splide'] a[href]";

export function isBannerDomContext(ctx: DomPathContext | null | undefined): boolean {
  if (!ctx) return false;
  const section = normalizeCategoryDisplay(ctx.section_heading ?? "");
  if (section && NON_BANNER_SECTION_RE.test(section)) return false;
  if (section && BANNER_SECTION_HEADING_RE.test(section)) return true;
  const path = `${ctx.dom_path ?? ""} ${(ctx.parent_labels ?? []).join(" ")}`;
  if (NON_BANNER_SECTION_RE.test(path)) return false;
  return BANNER_DOM_HINT_RE.test(path);
}

export function isMainHeroBannerContext(ctx?: DomPathContext | null): boolean {
  if (!ctx || !isBannerDomContext(ctx)) return false;
  const section = normalizeCategoryDisplay(ctx.section_heading ?? "");
  const path = ctx.dom_path ?? "";
  const inMain = ctx.landmark === "main" || /\bmain\b/i.test(path);
  const isHero = /메인|main|hero|visual|top|rolling/i.test(`${section} ${path}`);
  return inMain && isHero;
}

export function canonicalBannerCategory(ctx?: DomPathContext | null): string {
  if (isMainHeroBannerContext(ctx)) return "메인 배너";
  return "배너";
}

/** Post-LLM: unify category naming for banner carousel context. Does not drop candidates. */
export function applyBannerCategoryHints(
  suggestions: SnapshotSuggestion[],
  candidatesByTagId: Map<number, SnapshotCandidate>
): SnapshotSuggestion[] {
  return suggestions.map((s) => {
    const c = candidatesByTagId.get(s.tag_id);
    if (!c?.dom_path || !isBannerDomContext(c.dom_path)) return s;
    const next = canonicalBannerCategory(c.dom_path);
    if (normalizeCategoryDisplay(s.category) === next) return s;
    return { ...s, category: next };
  });
}
