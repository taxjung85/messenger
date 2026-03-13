# 채널 에이전트 패치 상세기술서

> **작성일**: 2026-03-14
> **버전**: v1.5.2 → v1.6.0 (예정)

---

## PATCH-001. 기한 설정 팝업 — 달력 UI

### 1. 변경 파일 및 위치

| 파일 | 라인 | 변경 유형 |
|------|------|-----------|
| `content-list.js` | L139~L241 | `showDayPopup()` 함수 전체 교체 |
| `content-list.js` | L596~L614 | 반복 일자 변경 호출처 — 반환값 처리 수정 |
| `content-list.js` | L769~L784 | To-Do 기한 설정 호출처 — 반환값 처리 수정 |

### 2. showDayPopup() 함수 구조

```
showDayPopup(title: string, currentDay: number|string)
  → Promise< {year, month, day} | null | -1 >
```

#### 내부 상태
| 변수 | 타입 | 설명 |
|------|------|------|
| `viewY`, `viewM` | number | 현재 보고 있는 년/월 (0-indexed month) |
| `todayY`, `todayM`, `todayD` | number | KST 기준 오늘 날짜 |
| `selectedDate` | object\|null | `{ year, month(1-indexed), day }` — 사용자가 선택한 날짜 |

#### 렌더링 흐름 (`render()` 함수)
1. **월 헤더**: `◀ 2026년 03월 ▶` — 좌우 버튼으로 월 이동
2. **요일 헤더**: 일~토 (7칸 grid), 일요일=빨강, 토요일=파랑
3. **날짜 그리드**: 7열 CSS Grid
   - `new Date(viewY, viewM, 1).getDay()` → 첫째 주 빈 셀 개수
   - `new Date(viewY, viewM + 1, 0).getDate()` → 해당 월 마지막 날짜
   - 각 셀 36×36px, border-radius 50%
4. **하단 버튼**: [확인] [취소] [삭제]

#### 셀 스타일 규칙
| 조건 | 스타일 |
|------|--------|
| 선택된 날짜 (`isSelected`) | `background: #6366f1; color: white` |
| 오늘 (`isToday`) | `box-shadow: inset 0 0 0 2px #6366f1; color: #6366f1` |
| 일요일 (미선택) | `color: #ef4444` |
| 토요일 (미선택) | `color: #3b82f6` |
| hover (미선택) | `background: #e0e7ff` |

#### 이벤트 핸들링
| 이벤트 | 동작 |
|--------|------|
| 날짜 셀 클릭 | `selectedDate` 갱신 → `render()` 재호출 |
| ◀ 클릭 | `viewM--` (underflow 시 `viewY--`, `viewM=11`) → `render()` |
| ▶ 클릭 | `viewM++` (overflow 시 `viewY++`, `viewM=0`) → `render()` |
| 확인 클릭 | `selectedDate`가 없으면 무시, 있으면 `resolve(selectedDate)` |
| 취소 클릭 / ESC / 오버레이 클릭 | `resolve(null)` |
| 삭제 클릭 | `resolve(-1)` |

### 3. 호출처 반환값 처리

#### 3-1. 반복 일자 변경 (L596)

**AS-IS**
```js
const result = await showDayPopup("반복 일자 변경", r.day_of_month);
if (result !== r.day_of_month) {
  await supabase.from("recurring_todos").update({ day_of_month: result })...
  const td = Math.min(result, ld);
  showToast((result === 31 ? "말일" : result + "일") + "로 변경됨", true);
}
```

**TO-BE**
```js
const result = await showDayPopup("반복 일자 변경", r.day_of_month);
const newDay = result.day;  // 객체에서 day만 추출
if (newDay !== r.day_of_month) {
  await supabase.from("recurring_todos").update({ day_of_month: newDay })...
  const td = Math.min(newDay, ld);
  showToast((newDay === 31 ? "말일" : newDay + "일") + "로 변경됨", true);
}
```

- `result` → `result.day`로 변환하여 기존 로직과 동일하게 1~31 숫자 사용
- `day_of_month` 저장, `recurring_date` 재계산 모두 `newDay` 사용

#### 3-2. To-Do 기한 설정 (L769)

**AS-IS**
```js
const result = await showDayPopup("기한 설정", dueDay || "");
// result는 숫자(일)
const now = new Date();
const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
const yyyy = kst.getFullYear();
const mm = String(kst.getMonth() + 1).padStart(2, "0");
const dd = String(result).padStart(2, "0");
await supabase.from("todos").update({ due_date: yyyy + "-" + mm + "-" + dd })...
```

**TO-BE**
```js
const result = await showDayPopup("기한 설정", dueDay || "");
// result는 { year, month, day } 객체
const yyyy = result.year;
const mm = String(result.month).padStart(2, "0");
const dd = String(result.day).padStart(2, "0");
await supabase.from("todos").update({ due_date: yyyy + "-" + mm + "-" + dd })...
```

- 기존: 현재 월 고정이므로 `new Date()`에서 년/월 추출
- 변경: 달력에서 월 이동이 가능하므로 `result.year`, `result.month`에서 직접 추출
- **핵심 개선**: 다른 달의 날짜도 기한으로 설정 가능

---

## PATCH-003. 자동 업데이트 기능

### 1. 변경 파일 및 위치

| 파일 | 라인 | 변경 유형 |
|------|------|-----------|
| `deploy.py` | L1 | `zipfile` import 추가 |
| `deploy.py` | L57~L98 | GitHub Release 생성 + Supabase download_url 저장 (신규 단계) |
| `deploy.py` | L100~L108 | 로컬 복사 단계 번호 변경 (4/4 → 5/5) |
| `native_host.py` | L6 | `zipfile`, `urllib.request`, `tempfile` import 추가 |
| `native_host.py` | L68~L84 | `update` 액션 추가 |
| `background.js` | L232~L264 | 알림 클릭 핸들러 — 업데이트 흐름으로 교체 |
| `background.js` | L496~L518 | `trigger-update` 메시지 핸들러 추가 |
| `content-list.js` | L1264~L1275 | 토스트 클릭 — `trigger-update` 메시지 전송으로 변경 |

### 2. deploy.py 배포 흐름 (5단계)

```
[1/5] manifest.json 버전 업데이트        ← 기존
[2/5] Supabase settings.app_version 업데이트  ← 기존 (번호만 변경)
[3/5] Git 커밋 + 푸시                    ← 기존 (번호만 변경)
[4/5] GitHub Release 생성                ← 신규
[5/5] 로컬 C:\extension 복사             ← 기존 (번호만 변경)
```

#### 4단계 상세 (GitHub Release)

```python
# 1. extension/ 폴더를 zip으로 압축
zip_path = "extension-v{version}.zip"
zipfile.ZipFile → os.walk(src_ext) → zf.write(full, "extension/상대경로")

# 2. gh CLI로 Release 생성
gh release create v{version} {zip_path} --title v{version} --notes "v{version} 릴리스"

# 3. Release 에셋 URL 조회
gh release view v{version} --json assets → assets[0].url

# 4. Supabase settings 테이블에 download_url 저장
PATCH /rest/v1/settings?key=eq.download_url  body: {"value": "{asset_url}"}

# 5. 임시 zip 파일 삭제 (finally 블록)
```

#### 예외 처리
| 상황 | 처리 |
|------|------|
| `gh` CLI 미설치 | `FileNotFoundError` → "gh CLI 미설치 — Release 생성 건너뜀" 출력, 계속 진행 |
| Release 생성 실패 | `Exception` → 에러 출력, 계속 진행 |
| zip 파일 잔존 | `finally` 블록에서 항상 삭제 |

### 3. native_host.py — update 액션

```python
action == 'update':
  입력: { downloadUrl: string, targetDir: string(기본 "C:\extension") }
  출력: { success: bool, path?: string, error?: string }
```

#### 처리 흐름
```
1. downloadUrl 검증 (없으면 에러 반환)
2. tempfile.mktemp(suffix='.zip') → 임시 경로 생성
3. urllib.request.urlretrieve(downloadUrl, tmp) → zip 다운로드
4. shutil.rmtree(targetDir) → 기존 폴더 삭제
5. zipfile.ZipFile.extractall(os.path.dirname(targetDir)) → 압축 해제
   → zip 내부가 "extension/" 폴더이므로 C:\ 에 풀면 C:\extension 이 됨
6. os.remove(tmp) → 임시 파일 삭제
7. send_message({ success: True, path: targetDir })
```

#### 주의사항
- zip 구조가 `extension/...` 이므로 `extractall`의 대상은 `C:\` (targetDir의 부모)
- 다운로드 실패, 압축 해제 실패 모두 `try/except`로 에러 메시지 반환

### 4. background.js — 업데이트 트리거

#### 4-1. 알림 클릭 핸들러 (L232~L264)

```
chrome.notifications.onClicked("version-update")
  ├─ supaRest("GET", "settings", "key=eq.download_url") → downloadUrl 조회
  ├─ downloadUrl 없음 → 기존 방식 (reload만)
  ├─ downloadUrl 있음 →
  │   chrome.runtime.sendNativeMessage("com.jungsem.messenger", {
  │     action: "update",
  │     downloadUrl: downloadUrl,
  │     targetDir: "C:\\extension"
  │   })
  │   ├─ 성공 → pendingTabReload 설정 → chrome.runtime.reload()
  │   └─ 실패 → 콘솔 에러 → 폴백 (reload만)
  └─ catch → 콘솔 에러 → 폴백 (reload만)
```

#### 4-2. trigger-update 메시지 핸들러 (L496~L518)

```
msg.type === "trigger-update"  (content-list.js 토스트에서 발신)
  ├─ chrome.notifications.clear("version-update")  — 알림 제거
  └─ 이하 알림 클릭과 동일한 흐름
      (supaRest → sendNativeMessage → reload)
```

#### 폴백 전략
- **3중 폴백**: 모든 실패 경로에서 `chrome.runtime.reload()` 실행
  - download_url 미존재 → reload
  - native host 실패 → reload
  - 예외 발생 → reload
- 최악의 경우에도 기존 동작(새로고침)은 보장

### 5. content-list.js — 토스트 UI 변경

**AS-IS**
```
토스트 텍스트: "클릭하여 새로고침"
클릭 → chrome.runtime.sendMessage({ type: "reload-extension" })
```

**TO-BE**
```
토스트 텍스트: "클릭하여 업데이트"
클릭 →
  1. 토스트 텍스트 변경: "⏳ 업데이트 중..."
  2. 토스트 클릭 비활성화 (pointerEvents: 'none')
  3. chrome.runtime.sendMessage({ type: "trigger-update" })
```

### 6. Supabase 사전 설정 필요

패치 배포 전 Supabase `settings` 테이블에 행 추가 필요:

```sql
INSERT INTO settings (key, value) VALUES ('download_url', '');
```

> `app_version` 행은 이미 존재. `download_url`은 첫 배포 시 `deploy.py`가 PATCH로 업데이트하므로 빈 값으로 생성만 해두면 됨.

### 7. 전제 조건

| 항목 | 상태 | 비고 |
|------|------|------|
| `gh` CLI 설치 | 개발 PC만 | 배포자(나)만 필요 |
| `nativeMessaging` 퍼미션 | ✅ 있음 | manifest.json |
| `downloads` 퍼미션 | ✅ 있음 | manifest.json |
| native_host.py 등록 | 양쪽 PC | 기존 셋업에 포함 |
| Supabase `download_url` 행 | 🔲 추가 필요 | 1회성 |

---

## 전체 변경 파일 요약

| 파일 | PATCH-001 | PATCH-003 |
|------|:---------:|:---------:|
| `content-list.js` | ✅ | ✅ |
| `background.js` | — | ✅ |
| `native_host.py` | — | ✅ |
| `deploy.py` | — | ✅ |
| `manifest.json` | — | — (변경 없음) |
