# GOI Live Dashboard — Release Notes

---

## v2.1 (2026-05-29)

### 🔒 Forecast Lock (8AM Snapshot)

**변경 내용:**
- 매일 오전 8시 이후 첫 로드 시 각 드라이버의 Forecast 값을 서버 DB에 저장
- 이후 5분마다 자동 새로고침 시 Forecast는 고정, Actual만 업데이트
- 오후 또는 다른 기기/브라우저에서 열어도 동일한 8시 기준 Forecast 표시
- Forecast 최대값 5,000L 캡 적용

**적용 범위:**
- Forecast vs Actual 바 차트 ✅
- Achievement % 차트 ✅
- Driver Status 테이블 ✅
- Remaining Collection 차트 ✅

**서버 요구사항:**
- `orders.php` 업데이트 필요 (`type=forecast` 분기 추가)
- DB에 `tbl_forecast_cache` 테이블 자동 생성 (첫 실행 시)

---

### 🕐 Arrival Time 컬럼 추가

**변경 내용:**
- Driver Status 테이블에 `ARRIVAL` 컬럼 추가
- 도착 시간 있는 드라이버는 초록색으로 표시

---

### ✅ Status 로직 변경

**기존:** Actual vs Forecast 비교로 상태 결정
**변경:** Arrival Time 입력 여부 기준

| 조건 | 상태 |
|---|---|
| Arrival 시간 있음 | ✅ Done |
| Arrival 없음 + Actual > 0 | ⟳ In Progress |
| Actual = 0 | — Pending |

---

### 🔧 버그 수정

- Driver Status 테이블에 일부 드라이버만 표시되던 문제 수정
  - 원인: DB에서 arrival 값이 문자열이 아닌 타입으로 반환될 경우 `.trim()` 오류 발생
  - 수정: `String(d.arrival)` 변환 후 처리, `innerHTML +=` 루프 방식 개선

---

### 🚀 배포 구조 변경

| 항목 | 변경 전 | 변경 후 |
|---|---|---|
| API 프록시 | Netlify Functions | **Vercel Functions** |
| HTML 호스팅 | Netlify | **GitHub Pages** |
| 코드 저장소 | 수동 배포 | **GitHub 자동 배포** |

**접속 URL:**
- `https://greenoilinc.github.io/greenoil-reports/goi_live_dashboard.html`

---

### 📋 서버 업로드 필요 파일

| 파일 | 경로 | 변경 내용 |
|---|---|---|
| `orders.php` | `assets/api/v1/orders.php` | `type=forecast` 분기 추가 (tbl_forecast_cache CRUD) |

---

## v2.0 (2026-05-23)

- Netlify Functions 기반 API 프록시 구축 (CORS 우회)
- Today / Yesterday / 날짜선택 버튼 추가
- 주말 자동 Yesterday 전환 기능
- 5분 자동 새로고침 (LIVE 표시)
