# Antigravity 외주 요청서

## 프로젝트 한 줄 요약
카카오톡 채널 관리자센터(business.kakao.com)에 삽입되는 **크롬 확장 사이드바**의 전체 UI/CSS 디자인

## 현재 상태
- 기능은 전부 동작 (To-Do, 반복 일정, AI 추천, 템플릿, 드래그앤드롭 등)
- CSS는 개발자가 급하게 작업한 상태 → **전문 디자이너가 전면 리디자인** 필요
- 인라인 스타일이 JS에 많이 섞여 있음 → CSS 클래스로 정리 필요

## 디자인 요구사항

### 컨셉
- **Glassmorphism + Indigo/Violet 그라디언트** 기조 유지
- 300px 고정 사이드바 (반응형 아님)
- Pretendard 폰트
- 깔끔하고 가독성 좋은 카드 UI

### 핵심 화면
1. **채팅방 사이드바** — AI 추천 답변 카드 + 템플릿 관리
2. **채팅 목록 사이드바** — To-Do 목록 + 반복 일정 (접이식)
3. **팝업/모달** — 메시지 분류, 입력, 반복 설정, 토스트
4. **말풍선 배지** — TODO/SALARY 미니 배지
5. **옵션 페이지** — API 키 설정 폼

### 레이아웃 특이사항
- 사이드바 body는 **flex column** 구조
- 반복 일정 섹션은 `margin-top: auto`로 **항상 하단 고정**
- 반복 일정 목록은 `max-height: 30vh`로 **화면 절반 이상 차지 금지**
- 반복 일정 헤더는 todo 헤더만큼 **큼직하게** (16px+, 굵은 아이콘)
- 접혀있어도 통계(미완료/완료) 헤더에 표시

### 인터랙션 (CSS 담당 부분)
- 드래그앤드롭 시각 피드백 (opacity, scale, border 변화)
- 호버 → 카드 lift, 왼쪽 컬러 바 나타남
- 더블클릭/클릭 편집 → input/select로 교체 시 스타일
- 체크박스 완료 → line-through + 연한 색
- 🔥 배지 → 펄스 glow 애니메이션
- 토스트 → 하단 중앙, fade out

## 산출물
1. **style.css** — 전체 리디자인
2. **sidebar.html** — 마크업 개선 (필요시)
3. **sidebar-list.html** — 마크업 개선 (필요시)
4. **options.html** — 디자인 개선
5. JS 동적 생성 요소용 **CSS 클래스 목록** (현재 인라인 → 클래스 전환 가이드)

## 참고 파일
- `UI_SPEC.md` — 상세 명세서 (컴포넌트별 구조, 디자인 토큰, 와이어프레임)
- `style.css` — 현재 CSS (참고용)
- `sidebar.html`, `sidebar-list.html` — 현재 HTML
- `content.js`, `content-list.js` — JS 동적 생성 요소 참고 (CSS 클래스명 확인용)

## 제약사항
- JS 로직 수정 불필요 (CSS/HTML만)
- 기존 ID/클래스명 변경 시 사전 협의 (JS에서 참조 중)
- `#ai-sidebar-container`의 z-index `999999` 유지 (카카오 페이지 위에 떠야 함)
- 크롬 확장이라 외부 CSS 프레임워크(Tailwind 등) 사용 불가 — 순수 CSS만
