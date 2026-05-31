"""
UCO Daily Data Update Script
매일 실행: MIS API + 8시 잠금 타겟 → uco_history.json 업데이트
           + 기존 Google Sheets 탭의 빈 셀만 채우기 (수동 입력값 보존)
"""
import json, os, re, requests, gspread, calendar, warnings, time
from datetime import datetime, timedelta, date
from google.oauth2.service_account import Credentials

warnings.filterwarnings('ignore')

# ── 설정 ──────────────────────────────────────────────────────────
MIS_API_KEY  = os.environ.get('MIS_API_KEY', 'GOI_DASHBOARD_2026_SECRET')
MIS_API_URL  = 'https://mis.greenoilinc.com/assets/api/v1/orders.php'
FORECAST_URL = 'https://greenoil-reports-greenoilincs-projects.vercel.app/api/forecast'
SHEET_ID     = os.environ.get('GOOGLE_SHEET_ID', '14znPnTJhVFP20vBmZTbV-3UOsohMiqKTGgh0TzkXIsM')
JSON_PATH    = os.path.join(os.path.dirname(__file__), '..', 'data', 'uco_history.json')

DRIVER_MAP = {
    'H.K': ('권호문',    'North 1'),
    'J.O': ('오종환',    'North 2'),
    'D.L': ('이다윗',    'East 2'),
    'M.K': ('김민',      'East 3'),
    'T.K': ('김태근',    'East 1'),
    'T.Y': ('유태규',    'West 1'),
    'J.S': ('송재혁',    'West 2'),
    'S.S': ('송성민',    'West Long'),
    'S.K': ('김성민',    'Downtown 1'),
    'S.L': ('Samuel Lee','Downtown 2'),
    'Y.S': ('송윤섭',    ''),
}
DRIVER_REGION = {v[0]: v[1] for v in DRIVER_MAP.values()}

# ── 유틸 ──────────────────────────────────────────────────────────
def parse_time(t):
    if not t: return None
    t = str(t).strip().split('(')[0].strip()
    if ':' in t:
        try: return datetime.strptime(t, "%H:%M")
        except: return None
    else:
        t = t.zfill(4)
        try: return datetime.strptime(t, "%H%M")
        except: return None

def calc_hours(dep, arr):
    d, a = parse_time(dep), parse_time(arr)
    if d and a:
        diff = (a - d).seconds / 3600
        return round(diff, 2) if diff > 0 else None
    return None

def parse_num(v):
    """'4,700' → 4700.0"""
    if not v or v == '': return None
    try: return float(str(v).replace(',', ''))
    except: return None

# ── 1단계: 업데이트할 날짜 ────────────────────────────────────────
def get_update_dates(json_data):
    existing = set(r['date'] for r in json_data['daily'])
    last = max(existing) if existing else '2026-01-01'
    start = datetime.strptime(last, '%Y-%m-%d').date() + timedelta(days=1)
    end   = date.today() - timedelta(days=1)
    dates = []
    d = start
    while d <= end:
        if d.weekday() != 6:
            dates.append(d)
        d += timedelta(days=1)
    return dates

# ── 2단계: MIS API ────────────────────────────────────────────────
def fetch_mis_data(dates):
    if not dates: return {}
    date_from = dates[0].strftime('%Y%m%d')
    date_to   = dates[-1].strftime('%Y%m%d')
    resp = requests.get(MIS_API_URL,
        params={'date_from': date_from, 'date_to': date_to},
        headers={'X-API-Key': MIS_API_KEY}, timeout=30)
    resp.raise_for_status()
    orders = resp.json().get('data', [])
    daily = {}
    for o in orders:
        dt, init = o['order_date_formatted'], o['driver']
        if init not in DRIVER_MAP: continue
        name, region = DRIVER_MAP[init]
        daily[(dt, name)] = {
            'init': init, 'region': region,
            'actual':   o.get('actual') or 0,
            'stops':    o.get('completed_stops') or 0,
            'hours':    calc_hours(o.get('departure'), o.get('arrival')),
            'forecast': o.get('forecast') or 0,
        }
    print(f"  MIS 데이터: {len(daily)}건 ({date_from}~{date_to})")
    return daily

# ── 3단계: 8시 잠금 타겟 ─────────────────────────────────────────
def fetch_locked_targets(dates):
    locked = {}
    for d in dates:
        date_str   = d.strftime('%Y-%m-%d')
        date_param = d.strftime('%Y%m%d')
        try:
            resp = requests.get(FORECAST_URL, params={'date': date_param}, timeout=10)
            data = resp.json()
            if data.get('data'):
                for init, val in data['data'].items():
                    if init in DRIVER_MAP:
                        name, _ = DRIVER_MAP[init]
                        locked[(date_str, name)] = val
        except Exception as e:
            print(f"  ⚠️  {date_str} 잠금값 실패: {e}")
    print(f"  8시 잠금값: {len(locked)}건")
    return locked

# ── 4단계: uco_history.json 업데이트 ─────────────────────────────
def update_json(json_data, dates, mis_daily, locked_targets):
    existing = {(r['date'], r['name']): i for i, r in enumerate(json_data['daily'])}
    added = 0
    for d in dates:
        ds = d.strftime('%Y-%m-%d')
        for init, (name, region) in DRIVER_MAP.items():
            key = (ds, name)
            mis = mis_daily.get(key)
            if not mis: continue
            target = locked_targets.get(key, mis['forecast'])
            record = {
                'date': ds, 'name': name, 'init': init,
                'region': region, 'target': target,
                'actual': mis['actual'], 'visits': mis['stops'],
                'hours': mis['hours'],
            }
            if key not in existing:
                json_data['daily'].append(record)
                added += 1
            else:
                json_data['daily'][existing[key]] = record
    json_data['generated'] = date.today().strftime('%Y-%m-%d')
    json_data['date_range'] = [
        min(r['date'] for r in json_data['daily']),
        max(r['date'] for r in json_data['daily']),
    ]
    print(f"  JSON 업데이트: {added}건 추가")
    return json_data

# ── 5단계: 기존 시트 탭 빈 셀 채우기 ────────────────────────────
def get_sheets_client():
    sa_key_path = os.environ.get('GOOGLE_SA_KEY_PATH')
    if not sa_key_path or not os.path.exists(sa_key_path):
        print("  ⚠️  GOOGLE_SA_KEY_PATH 없음, Sheets 업데이트 건너뜀")
        return None
    creds = Credentials.from_service_account_file(sa_key_path,
        scopes=['https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/drive'])
    gc = gspread.authorize(creds)
    return gc.open_by_key(SHEET_ID)

def fill_empty_cells(sh, tab_name, mis_daily, locked_targets):
    """기존 탭에서 빈 셀만 API 데이터로 채우기 (수동 입력값 보존)"""
    try:
        ws = sh.worksheet(tab_name)
    except:
        print(f"  ⚠️  '{tab_name}' 탭 없음, 건너뜀")
        return

    data = ws.get_all_values()
    if len(data) < 12:
        print(f"  ⚠️  '{tab_name}' 데이터 부족")
        return

    # 헤더행(행11, index 10)에서 날짜→컬럼 매핑
    header = data[10]
    year_mon = tab_name.replace('년 ', '-').replace('월', '').strip()
    parts = year_mon.split('-')
    year = 2000 + int(parts[0])
    mon  = int(parts[1])

    col_map = {}  # "YYYY-MM-DD" → col_index (0-based)
    skip_cols = set()
    for ci, cell in enumerate(header):
        if not cell: continue
        if re.match(r'^\d+/\d+$', cell):
            # "5/1" → "2026-05-01"
            m_day = cell.split('/')
            try:
                ds = f"{year}-{int(m_day[0]):02d}-{int(m_day[1]):02d}"
                col_map[ds] = ci
            except: pass
        elif 'Total' in cell or 'OT' in cell or cell == 'TOTAL' or cell == 'Monthly OT':
            skip_cols.add(ci)

    # 드라이버→행 매핑
    SKIP_LABELS = {'Install 및 Extra', 'TOTAL', '총 수거양', 'Install'}
    ROW_TYPES = {'Target 양': 0, '실제 수거양': 1, '방문수': 2, 'Working Hrs': 3}

    driver_rows = {}  # driver_name → (target_row, actual_row, visit_row, hours_row) (0-based)
    current_driver = None
    current_start  = None

    for ri, row in enumerate(data[11:], 11):
        b_cell = row[1].strip() if len(row) > 1 else ''
        c_cell = row[2].strip() if len(row) > 2 else ''

        # 새 드라이버 감지
        if b_cell and b_cell not in SKIP_LABELS and c_cell == 'Target 양':
            # 드라이버명 정제 (개행문자, 괄호 제거)
            driver_name = b_cell.split('\n')[0].strip()
            current_driver = driver_name
            current_start  = ri
            driver_rows[driver_name] = [ri, ri+1, ri+2, ri+3]

    print(f"  '{tab_name}': 드라이버 {len(driver_rows)}명, 날짜 {len(col_map)}일")

    # 채울 셀 수집
    updates = []  # (row, col, value) — 1-based

    for driver_name, row_indices in driver_rows.items():
        # driver_name이 DRIVER_MAP의 어떤 name과 매칭되는지 확인
        matched_name = None
        for init, (name, region) in DRIVER_MAP.items():
            if name == driver_name or name in driver_name or driver_name in name:
                matched_name = name
                break
        if not matched_name:
            continue

        tgt_ri, act_ri, vis_ri, hrs_ri = row_indices

        for ds, ci in col_map.items():
            mis = mis_daily.get((ds, matched_name))
            locked = locked_targets.get((ds, matched_name))

            if not mis: continue

            target_val = locked if locked else mis['forecast']

            # 각 행의 해당 셀이 비어있으면 채우기
            def is_empty(row_i, col_i):
                try: return not data[row_i][col_i].strip()
                except: return True

            if is_empty(tgt_ri, ci) and target_val:
                updates.append((tgt_ri+1, ci+1, int(target_val)))
            if is_empty(act_ri, ci) and mis['actual']:
                updates.append((act_ri+1, ci+1, int(mis['actual'])))
            if is_empty(vis_ri, ci) and mis['stops']:
                updates.append((vis_ri+1, ci+1, int(mis['stops'])))
            if is_empty(hrs_ri, ci) and mis['hours']:
                updates.append((hrs_ri+1, ci+1, round(mis['hours'], 2)))

    if not updates:
        print(f"  '{tab_name}': 채울 빈 셀 없음")
        return

    # 셀별 업데이트 (batch_update 대신 안정적인 방식)
    for r, c, v in updates:
        ws.update(gspread.utils.rowcol_to_a1(r, c), [[v]])
        time.sleep(0.2)
    print(f"  '{tab_name}': {len(updates)}개 셀 채움 ✅")

def update_sheets_fill(json_data, dates):
    """업데이트된 월의 기존 탭에 빈 셀 채우기"""
    sh = get_sheets_client()
    if not sh: return

    # 이번 달과 업데이트된 달 모두 처리
    months = set((d.year, d.month) for d in dates)
    today = date.today()
    months.add((today.year, today.month))

    for year, mon in sorted(months):
        ym_prefix = f"{year}-{mon:02d}"
        tab_name  = f"{str(year)[2:]}년 {mon}월"

        # 해당 월 전체 MIS 데이터 가져오기
        month_days = []
        cal_weeks = calendar.monthcalendar(year, mon)
        for week in cal_weeks:
            for i, day in enumerate(week):
                if day != 0 and i != 6:
                    month_days.append(date(year, mon, day))

        print(f"\n  [{tab_name}] MIS 전체 월 데이터 수집...")
        mis_month = fetch_mis_data(month_days)
        locked_month = fetch_locked_targets(month_days)

        fill_empty_cells(sh, tab_name, mis_month, locked_month)
        time.sleep(2)

# ── 메인 ─────────────────────────────────────────────────────────
def main():
    print(f"\n{'='*50}")
    print(f"UCO Data Update - {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print('='*50)

    with open(JSON_PATH, encoding='utf-8') as f:
        json_data = json.load(f)

    dates = get_update_dates(json_data)

    if dates:
        print(f"\n업데이트 날짜: {dates[0]} ~ {dates[-1]} ({len(dates)}일)")
        print("\n[1] MIS API 수거 데이터 수집...")
        mis_daily = fetch_mis_data(dates)
        print("\n[2] 8시 잠금 타겟 수집...")
        locked_targets = fetch_locked_targets(dates)
        print("\n[3] uco_history.json 업데이트...")
        json_data = update_json(json_data, dates, mis_daily, locked_targets)
        with open(JSON_PATH, 'w', encoding='utf-8') as f:
            json.dump(json_data, f, ensure_ascii=False, separators=(',',':'))
        print(f"  저장 완료")
    else:
        print("\n✅ JSON 이미 최신 상태")
        dates = [date.today()]  # 오늘 날짜로 Sheets는 업데이트

    print("\n[4] Google Sheets 빈 셀 채우기...")
    update_sheets_fill(json_data, dates)

    print(f"\n{'='*50}")
    print("✅ 전체 업데이트 완료!")
    print('='*50)

if __name__ == '__main__':
    main()
