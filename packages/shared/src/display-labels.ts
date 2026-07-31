/** Korean display labels for UI grouping (category / action). */

import { isGlobalNavCategory } from "./candidate-group.js";

const CATEGORY_KO: Record<string, string> = {
  "global/gnb": "GNB",
  "global/fnb": "Footer",
  hero: "배너",
  main_banner: "메인 배너",
  main: "메인",
  banner: "배너",
  product_list: "상품 목록",
  product: "상품",
  recommendation: "추천 상품",
  recommend: "추천 상품",
  search: "검색",
  footer: "푸터",
  header: "헤더",
  popup: "팝업",
  modal: "모달",
  cart: "장바구니",
  wishlist: "찜",
  login: "로그인",
  signup: "회원가입",
  lounge: "라운지",
  store: "스토어",
};

const ACTION_KO: Record<string, string> = {
  click_gnb: "GNB 메뉴",
  click_fnb: "Footer 메뉴",
  slide_nav: "슬라이드 이동",
  add_to_cart: "장바구니 담기",
  add_wishlist: "찜하기",
  view_detail: "상세 보기",
  navigate: "이동",
  open_menu: "메뉴 열기",
  search: "검색",
  login: "로그인",
  signup: "회원가입",
};

const GENERIC_GROUPING_ACTIONS = new Set([
  "navigate",
  "click",
  "interact",
  "menu",
  "open_menu",
  "nav_link",
  "link",
  "click_gnb",
  "click_fnb",
]);

/** True when tree action row should show event_name instead of raw action slug. */
export function isGenericGroupingAction(action: string): boolean {
  const act = action.toLowerCase().trim();
  if (!act) return true;
  if (GENERIC_GROUPING_ACTIONS.has(act)) return true;
  if (/^click_/.test(act)) return true;
  return false;
}

/** Middle-tier label: event_name for generic click/interact, else Korean action name. */
export function formatGroupingActionDisplay(candidate: {
  action: string;
  event_name?: string | null;
}): string {
  const act = candidate.action?.toLowerCase().trim() ?? "";
  if (isGenericGroupingAction(act)) {
    const en = candidate.event_name?.trim();
    if (en) return en;
  }
  return formatActionDisplay(candidate.action);
}

/**
 * Bucket key for optional action-tier grouping — uses LLM action_key/action or event_name only.
 * No regex-based semantic inference.
 */
export function groupingActionBucketKey(candidate: {
  action?: string;
  action_key?: string;
  event_name?: string | null;
}): string {
  const raw = candidate.action_key?.trim() || candidate.action?.trim() || "";
  const key = raw.toLowerCase();
  if (key && !isGenericGroupingAction(key)) return raw;
  const en = candidate.event_name?.trim();
  if (en) return `evt::${en}`;
  return raw || "click";
}

/** True when action layer adds no distinct meaning vs category (GNB vs "GNB 메뉴" etc.). */
export function isRedundantGroupingAction(
  category: string,
  action: string,
  displayAction?: string
): boolean {
  const act = action.toLowerCase().trim();
  if (!act || GENERIC_GROUPING_ACTIONS.has(act)) return true;

  if (isGlobalNavCategory(category)) {
    if (act.startsWith("click_") || act.includes("nav")) return true;
  }

  const catKo = formatCategoryDisplay(category).toLowerCase().replace(/\s+/g, "");
  const actKo = (displayAction || formatActionDisplay(action))
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/메뉴/g, "");
  if (!catKo || !actKo) return false;
  if (actKo.includes(catKo) || catKo.includes(actKo)) return true;

  return false;
}

/** Korean area name from category path. */
export function formatCategoryDisplay(category: string): string {
  const raw = category.trim();
  if (!raw) return "기타";

  const key = raw.toLowerCase();
  if (CATEGORY_KO[key]) return CATEGORY_KO[key];

  const lastSeg = raw.split("/").pop()?.trim() ?? raw;
  const lastKey = lastSeg.toLowerCase();
  if (CATEGORY_KO[lastKey]) return CATEGORY_KO[lastKey];

  const compact = lastSeg.replace(/\s+/g, "").toLowerCase();
  if (compact.includes("배너") || /banner|carousel|slider|swiper|hero/.test(compact)) {
    return /메인|main|hero|top/.test(compact) ? "메인 배너" : "배너";
  }

  if (/[\uAC00-\uD7A3]/.test(lastSeg)) return lastSeg;

  return lastSeg.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Korean action label for group meta. */
export function formatActionDisplay(action: string): string {
  const key = action.toLowerCase().trim();
  if (ACTION_KO[key]) return ACTION_KO[key];

  if (/^click_/.test(key)) {
    const rest = key.slice(6).replace(/_/g, " ");
    return rest ? `${rest} 클릭` : "클릭";
  }

  return key.replace(/_/g, " ");
}

/** Group header: area name for multi-member, button label for singleton. */
export function buildGroupDisplayLabel(
  category: string,
  action: string,
  members: Array<{ label?: string; text?: string }>
): string {
  if (isGlobalNavCategory(category)) {
    const c = category.toLowerCase();
    if (c.startsWith("global/fnb")) return "Footer";
    if (c.startsWith("global/gnb")) return "GNB";
  }

  const catKo = formatCategoryDisplay(category);

  if (members.length > 1) {
    return catKo;
  }

  const first = members[0];
  const btnLabel = (first?.label || first?.text || "").trim();
  if (btnLabel && /[\uAC00-\uD7A3]/.test(btnLabel)) return btnLabel;
  if (btnLabel) return btnLabel;
  return catKo || formatActionDisplay(action);
}
