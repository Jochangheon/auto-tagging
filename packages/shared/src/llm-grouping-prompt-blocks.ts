/** Shared LLM prompt blocks for consistent grouping and 3-level tree depth. */
export const LLM_CONSISTENT_GROUPING_BLOCK = `
Consistent grouping for de-duplication (CRITICAL):
- 화면상 같은 위치의 같은 텍스트 버튼은 DOM 태그가 a/button/div로 달라도 반드시 동일한 page_category + category(영역) + event_name + label + merge_label을 부여하라.
- 같은 link_url + 조상/자손 DOM 관계의 중복 래퍼는 서버에서 제거됨 — 남은 tag_id만 분류.
- 같은 section(landmark+section_heading) 아래 요소는 category(영역)를 하나로 통일 (예: "추천 상품" — "추천상품 리스트" 등으로 쪼개지 말 것).
- event_name은 레지스트리에서 재사용 — 같은 성격의 버튼에 서로 다른 event_name을 주지 말 것.
- 목적지 link_url이 다른 콘텐츠 링크는 동일 merge_label로 억지로 묶지 말 것 (서버도 URL이 다르면 분리).
- 기능 반복 버튼(찜/장바구니)만 동일 merge_label로 묶는다.`.trim();

export const LLM_DEPTH_RULE_BLOCK = `
Depth rule (CRITICAL — 트리는 정확히 3단계):
- 최종 구조는 page_category(페이지명, 예: 메인/정품등록) → category(영역명, 예: 배너/추천 상품/global/gnb) → merge_label(묶기·택소노미 행 이름) 이하의 3단계까지만 의미를 가진다.
- page_category=페이지 자체 이름, category=그 페이지 안의 화면 영역, merge_label=택소노미에서 한 줄로 묶일 이름. label=사람이 읽는 개별 이름(상품명 등).
- merge_label은 최종 말단(leaf) 그룹 키이다. merge_label 밑에 또 다른 하위가 생기면 안 된다.
- 같은 category(영역) 안에서 merge_label이 같으면 하나의 항목으로 취급되도록 동일하게 부여하라.`.trim();

/** label = display name per element; merge_label = taxonomy row key */
export const LLM_LABEL_RULE_BLOCK = `
Label rules (CRITICAL — 사람이 읽는 개별 이름):
- label은 이 요소를 클릭했을 때 화면에 보이는 **개별** 이름이다 (상품명, 탭명, 버튼 텍스트 등).
- 아이콘-only·짧은 액션 버튼(찜/하트, 장바구니, 삭제, 공유 등)은 기능명을 label로 쓴다: "찜하기", "장바구니 담기".
- 텍스트 링크/메뉴 → 화면 텍스트 그대로: "공지사항", "더보기", "로그인".
- 상품 카드 링크 → **상품명 그대로** label (예: "이터널 마운틴 | 카누 바리스타 전용캡슐 (10캡슐)").
- 탭 → **탭명 그대로** label (예: "카누 캡슐", "카누 머신") — 상품명과 혼동하지 말 것.
- 배너 이전/다음 → label="이전"|"다음".`.trim();

export const LLM_MERGE_LABEL_RULE_BLOCK = `
merge_label rules (CRITICAL — 택소노미 묶기 키):
- merge_label은 택소노미·트리에서 묶일 이름이다. label(개별 표시명)과 분리한다.
- 반복되는 장바구니 버튼(상품마다 다른 link_url) → merge_label 전부 "장바구니 담기".
- 반복되는 찜/하트 버튼 → merge_label 전부 "찜하기".
- 목적지(link_url)가 다른 콘텐츠 링크(로고·성공사례·상품카드·캠페인 배너 링크) → merge_label을 같게 쓰지 말 것. 각 목적지에 맞는 개별 이름(브랜드명·캠페인명·상품명)을 merge_label/label로 부여.
- 탭(카누 캡슐, 카누 머신 등) → merge_label = **각 탭명 그대로**. 탭끼리 묶지 말 것.
- GNB/FNB 메뉴 → merge_label = label(메뉴명) 그대로, 같은 메뉴면 동일 merge_label.
- 배너 이전/다음/도트 → merge_label 각각 "이전", "다음", "도트".
- 서버는 link_url이 다르면 같은 merge_label이어도 트리에서 분리한다. 기능 버튼(찜/장바구니)만 동일 merge_label로 묶어도 된다.
- merge_label은 필수. 모든 suggestion에 반드시 포함.`.trim();

export const LLM_BANNER_RULE_BLOCK = `
Banner rules (CRITICAL — 수집은 코드가 전부 함, LLM은 빠짐없이 분류·표현):
- 화면상 **배너/캐러셀/히어로 슬라이더**로 확실한 요소는 candidate로 오면 **반드시** suggestion을 낸다. 누락 금지.
- 대상: 메인 히어로 롤링 배너, 콘텐츠 롤링 배너 — 이전/다음 화살표, pagination 도트, 슬라이드 배너 링크(캠페인 이동), 클릭 가능한 슬라이드 영역.
- 추천상품·상품카드 swiper는 배너가 아님 → category에 "배너" 쓰지 말 것.
- category: 최상단 히어로만 "메인 배너", 그 외 롤링 배너는 "배너". 혜택·프로모션·메인 등 다른 영역명 금지.
- 이전/다음: event_name="배너이동", label="이전"|"다음", merge_label="이전"|"다음", parameters direction.
- pagination 도트: event_name="배너이동", label="도트", merge_label="도트" (모든 도트 동일).
- 슬라이드 링크: event_name="클릭", label="배너 (캠페인명)", merge_label="배너 (캠페인명)" 또는 캠페인별 구분.
- 같은 캐러셀 영역은 category(영역명) 하나로 통일.`.trim();

/** Spacing / spelling stability — prevent near-duplicate names from whitespace. */
export const LLM_NAME_STABILITY_BLOCK = `
Naming stability (CRITICAL — 띄어쓰기·표기 통일):
- event_name은 **공백 없이** 한글로 쓴다. 예: "클릭", "배너이동", "찜하기" (X: "배너 이동", "찜 하기").
- 레지스트리에 이미 있는 이름과 의미가 같으면 **글자·공백까지 레지스트리 문자열을 그대로 복사**해 재사용. 비슷한 새 이름을 만들지 말 것.
- category / label / merge_label: 연속 공백·탭을 쓰지 말고 단어 사이 공백은 최대 1칸. 같은 영역을 "추천 상품"과 "추천상품"으로 갈라쓰지 말 것 — 한 배치 안에서 한 표기로 고정.
- 화면 텍스트 label은 원문을 따르되, 앞뒤 공백·중복 공백만 정리. 의미 없는 표기 변형으로 행을 쪼개지 말 것.
- 새 event_name을 만들 때도 공백·언더스코어·영문 접두어 금지.`.trim();

export function llmExactCountWithDedupHint(candidateCount: number): string {
  return `- 모든 candidate에 대해 빠짐없이 suggestion을 반환하되(개수 일치 필수, suggestions.length === ${candidateCount}),
  중복으로 판단되는 후보들에는 의도적으로 동일한 page_category+category+event_name+merge_label을 부여하여 서버 그룹핑 단계에서 하나로 합쳐지도록 하라. (LLM이 직접 개수를 줄이지는 말 것)`;
}
