# 채널 에이전트 패치 기획

> **작성일**: 2026-03-13
> **담당**: 기획

---

## PATCH-001. 기한 설정 팝업 — 달력(캘린더) UI로 변경

### 현재 상태 (AS-IS)
- `showDayPopup()` 함수가 **숫자 스피너(input type=number)** 로 일(DD)만 입력받는 형태
- 현재 월(YYYY년 MM월) 고정 표시, 월 이동 불가
- 직관성이 떨어져 사용자가 날짜 감각을 잡기 어려움

### 변경 사항 (TO-BE)
- **팝업 형식은 유지**하되, 내부 UI를 **월간 달력 그리드**로 교체
- 요일 헤더(일~토) + 날짜 셀(1~31) 그리드 배치
- **월 이동**(◀ ▶) 지원 — 다음 달/이전 달 기한 설정 가능
- 오늘 날짜 하이라이트 (인디고 링)
- 선택된 날짜 강조 (인디고 채움)
- 주말(토/일) 색상 구분
- 하단 버튼: [확인] [취소] [삭제]

### 적용 범위
| 호출처 | 파일 | 동작 |
|--------|------|------|
| To-Do 기한 설정 | `content-list.js` L721 | 달력에서 날짜 선택 → `due_date` 저장 (YYYY-MM-DD) |
| 반복 일자 변경 | `content-list.js` L547 | 달력에서 일(day) 선택 → `day_of_month` 저장 (1~31) |

### 반환값 호환
- 기존: `null`(취소), `-1`(삭제), `숫자`(일)
- 변경: `null`(취소), `-1`(삭제), `{ year, month, day }` 객체
  - 반복 일자 변경 호출처는 `result.day`만 사용
  - To-Do 기한 설정 호출처는 `result.year + result.month + result.day`로 full date 구성

### 디자인 가이드
- 기존 디자인 토큰(인디고 계열) 유지
- Glassmorphism 팝업 스타일 유지 (`.ai-popup-overlay` + `.ai-popup-box`)
- 달력 셀: 36px × 36px, border-radius 50%, hover 시 배경색 변경
- 팝업 폭: 300px (사이드바 폭과 동일)
- 폰트: Pretendard 유지

### 기한
- **2026-03-16**

---

## PATCH-003. 자동 업데이트 기능 (구글드라이브 → 로컬 다운로드)

### 배경
- 현재: `deploy.py` 실행 → GitHub 푸시 + Supabase 버전 업데이트 + 개발자 로컬(`C:\extension`) 복사
- 사용자(문정 등)는 새 버전 **알림만** 받고, 실제 파일은 수동으로 받아야 함
- 두 사람 모두 구글드라이브에 프로그램을 저장하지 않으므로, **배포 후 각자 다운로드**하는 흐름 필요

### 현재 상태 (AS-IS)
1. `background.js` — Supabase `settings.app_version`과 로컬 `manifest.version` 비교
2. 버전 불일치 시 **크롬 알림** + content script 토스트 메시지 표시
3. 알림 클릭 → `chrome.runtime.reload()` (파일 교체 없이 리로드만)
4. 실제 새 파일을 받으려면 사용자가 직접 GitHub 등에서 다운로드해야 함

### 변경 사항 (TO-BE)

#### 배포 흐름
```
deploy.py 실행
  ├─ manifest.json 버전 업데이트
  ├─ Supabase settings.app_version 업데이트
  ├─ Supabase settings.download_url 에 GitHub Release zip URL 저장 (신규)
  ├─ GitHub 푸시 + Release 생성 (신규)
  └─ 로컬 C:\extension 복사 (기존)
```

#### 사용자 업데이트 흐름
```
버전 불일치 감지 (기존 checkVersionUpdate)
  ├─ 크롬 알림: "v1.6.0 업데이트 가능 — 클릭하여 다운로드"
  ├─ 알림 클릭 or 토스트 클릭
  │   ├─ Supabase에서 download_url 조회
  │   ├─ chrome.downloads API로 zip 다운로드 (Downloads 폴더)
  │   ├─ native_host.py 경유 → zip 압축 해제 → C:\extension 덮어쓰기
  │   └─ chrome.runtime.reload() → 자동 반영
  └─ 완료 토스트: "v1.6.0 업데이트 완료!"
```

### 핵심 변경 포인트

| 파일 | 변경 내용 |
|------|-----------|
| `deploy.py` | GitHub Release 자동 생성 + zip 업로드, Supabase에 `download_url` 저장 |
| `background.js` | 알림 클릭 시 다운로드 + native host 호출로 압축 해제/교체 |
| `native_host.py` | `update` 커맨드 추가 — zip 수신 → 지정 경로에 압축 해제 |
| `content-list.js` | 토스트 클릭 시 업데이트 트리거 메시지 전송 |
| `manifest.json` | `downloads` 퍼미션 이미 있음 ✅ |

### 대안 검토
| 방안 | 장점 | 단점 |
|------|------|------|
| **A. GitHub Release zip** | 무료, 용량 무제한, deploy.py에서 `gh release` 한 줄 | GitHub 접근 필요 |
| B. Supabase Storage | 인프라 통일 | 무료 1GB 제한, 대역폭 제한 |
| C. 구글드라이브 공유 링크 | 별도 인프라 불필요 | API 인증 복잡, 다운로드 URL 불안정 |

→ **A안 채택** (GitHub Release)

### 고려사항
- native_host.py가 설치되어 있어야 압축 해제/파일 교체 가능 → 초기 셋업 가이드 필요
- 업데이트 중 확장 프로그램 충돌 방지: 다운로드 완료 후 reload
- 롤백: 이전 버전 zip도 Release에 남아있으므로 수동 롤백 가능

### 기한
- **TBD** (PATCH-001 완료 후 진행)

---

*이후 패치 항목은 아래에 추가*
