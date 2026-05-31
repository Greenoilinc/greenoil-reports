"""
UCO Daily Data Update Script
매일 실행: MIS API + 8시 잠금 타겟 → uco_history.json 업데이트 → Google Sheets 기입
"""
import json, os, sys, requests, gspread, calendar, warnings, time
from datetime import datetime, timedelta, date
from google.oauth2.service_account import Credentials

warnings.filterwarnings('ignore')

# ── 설정 ──────────────────────────────────────────────────────────
MIS_API_KEY   = os.environ.get('MIS_API_KEY', 'GOI_DASHBOARD_2026_SECRET')
MIS_API_URL   = 'https://mis.greenoilinc.com/assets/api/v1/orders.php'
FORECAST_URL  = 'https://greenoil-reports-greenoilincs-projects.vercel.app/api/forecast'
SHEET_ID      = os.environ.get('GOOGLE_SHEET_ID', '14znPnTJhVFP20vBmZTbV-3UOsohMiqKTGgh0TzkXIsM')
JSON_PATH     = os.path.join(os.path.dirname(__file__), '..', 'data', 'uco_history.json')

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
DRIVER_ORDER = ['오종환','김태근','송재혁','Samuel Lee','유태규','김성민','이다윗','김민','권호문','송성민','송윤섭']
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

def col_letter(idx):
    result = ''; idx += 1
    while idx:
        idx, rem = divmod(idx - 1, 26)
        result = chr(65 + rem) + result
    return result

# ── 1단계: 날짜 범위 결정 ─────────────────────────────────────────
def get_update_dates(json_data):
    """JSON의 마지막 날짜 다음부터 어제까지 업데이트"""
    existing_dates = set(r['date'] for r in json_data['daily'])
    last_date = max(existing_dates) if existing_dates else '2026-01-01'
    start = datetime.strptime(last_date, '%Y-%m-%d').date() + timedelta(days=1)
    end   = date.today() - timedelta(days=1)  # 어제까지

    dates = []
    d = start
    while d <= end:
        if d.weekday() != 6:  # 일요일 제외
            dates.append(d)
        d += timedelta(days=1)
    return dates

# ── 2단계: MIS API 데이터 가져오기 ───────────────────────────────
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
            'init':    init,
            'region':  region,
            'actual':  o.get('actual') or 0,
            'stops':   o.get('completed_stops') or 0,
            'hours':   calc_hours(o.get('departure'), o.get('arrival')),
            'forecast': o.get('forecast') or 0,
        }
    print(f"  MIS 데이터: {len(daily)}건 ({date_from}~{date_to})")
    return daily

# ── 3단계: 8시 잠금 타겟 가져오기 ────────────────────────────────
def fetch_locked_targets(dates):
    locked = {}
    for d in dates:
        date_str = d.strftime('%Y-%m-%d')
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
            print(f"  ⚠️  {date_str} 잠금값 조회 실패: {e}")
    print(f"  8시 잠금값: {len(locked)}건")
    return locked

# ── 4단계: JSON 업데이트 ─────────────────────────────────────────
def update_json(json_data, dates, mis_daily, locked_targets):
    existing = {(r['date'], r['name']): r for r in json_data['daily']}
    added = 0

    for d in dates:
        date_str = d.strftime('%Y-%m-%d')
        for driver in DRIVER_ORDER:
            key = (date_str, driver)
            mis = mis_daily.get(key)
            if not mis: continue

            # Target: 8시 잠금 우선, 없으면 forecast fallback
            target = locked_targets.get(key, mis['forecast'])

            record = {
                'date':   date_str,
                'name':   driver,
                'init':   mis['init'],
                'region': DRIVER_REGION.get(driver, ''),
                'target': target,
                'actual': mis['actual'],
                'visits': mis['stops'],
                'hours':  mis['hours'],
            }

            if key not in existing:
                json_data['daily'].append(record)
                added += 1
            else:
                # 기존 레코드 업데이트 (인덱스 찾아서)
                for i, r in enumerate(json_data['daily']):
                    if r['date'] == date_str and r['name'] == driver:
                        json_data['daily'][i] = record
                        break

    json_data['generated'] = date.today().strftime('%Y-%m-%d')
    json_data['date_range'] = [
        min(r['date'] for r in json_data['daily']),
        max(r['date'] for r in json_data['daily']),
    ]
    print(f"  JSON 업데이트: {added}건 추가")
    return json_data

# ── 5단계: Google Sheets 월별 탭 업데이트 ────────────────────────
def _get_sheets_client():
    sa_key_path = os.environ.get('GOOGLE_SA_KEY_PATH')
    if not sa_key_path or not os.path.exists(sa_key_path):
        print("  ⚠️  GOOGLE_SA_KEY_PATH 없음, Sheets 업데이트 건너뜀")
        return None, None
    creds = Credentials.from_service_account_file(sa_key_path,
        scopes=['https://www.googleapis.com/auth/spreadsheets',
                'https://www.googleapis.com/auth/drive'])
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(SHEET_ID)
    return gc, sh

def _rebuild_current_month_sheet(json_data):
    """JSON 데이터로 현재 월 시트 전체 재구성"""
    today = date.today()
    year, mon = today.year, today.month
    ym_prefix = f"{year}-{mon:02d}"
    month_records = [r for r in json_data['daily'] if r['date'].startswith(ym_prefix)]
    if not month_records:
        # 이번 달 데이터 없으면 전월 확인
        prev = date(today.year, today.month, 1) - timedelta(days=1)
        ym_prefix = f"{prev.year}-{prev.month:02d}"
        year, mon = prev.year, prev.month
        month_records = [r for r in json_data['daily'] if r['date'].startswith(ym_prefix)]

    full_mis = {}
    full_locked = {}
    for r in month_records:
        key = (r['date'], r['name'])
        full_mis[key] = {
            'init': r.get('init', ''), 'region': r.get('region', ''),
            'actual': r.get('actual', 0), 'stops': r.get('visits', 0),
            'hours': r.get('hours'), 'forecast': r.get('target', 0),
        }
        full_locked[key] = r.get('target', 0)

    print(f"  {ym_prefix} 시트 재구성: {len(month_records)}건")
    update_google_sheets_month(year, mon, full_mis, full_locked)

def update_google_sheets_month(year, mon, mis_daily, locked_targets):
    gc, sh = _get_sheets_client()
    if not sh: return
    tab_name = f"{str(year)[2:]}년 {mon}월 (AUTO)"
    _update_month_tab(sh, tab_name, year, mon, mis_daily, locked_targets)

def update_google_sheets(dates, mis_daily, locked_targets):
    gc, sh = _get_sheets_client()
    if not sh: return
    months = sorted(set((d.year, d.month) for d in dates))
    for year, mon in months:
        tab_name = f"{str(year)[2:]}년 {mon}월 (AUTO)"
        _update_month_tab(sh, tab_name, year, mon, mis_daily, locked_targets)
        time.sleep(3)

def _update_month_tab(sh, tab_name, year, mon, mis_daily, locked_targets):
    """월별 탭 전체 재생성"""
    from gspread_formatting import (format_cell_ranges, format_cell_range,
        CellFormat, Color, TextFormat, NumberFormat,
        set_column_width, set_row_height)

    cal_weeks = calendar.monthcalendar(year, mon)
    weeks = []
    for week in cal_weeks:
        days = [datetime(year, mon, day) for i, day in enumerate(week) if day != 0 and i != 6]
        if days: weeks.append(days)

    # 컬럼 구조
    header = ['', 'Driver별 오일 수거양(L)', '']
    col_map = {}; wtc = {}; woc = {}; ci = 3
    for wi, wd in enumerate(weeks):
        for day in wd:
            header.append(f"{mon}/{day.day}")
            col_map[day.strftime('%Y-%m-%d')] = ci; ci += 1
        header.append(f'Week {wi+1} Total'); wtc[wi+1] = ci; ci += 1
        header.append(f'W{wi+1} OT'); woc[wi+1] = ci; ci += 1
    header.append('TOTAL'); total_col = ci; ci += 1
    header.append('Monthly OT'); nc = len(header)

    def er(n): return ['']*n

    rows = []
    r = er(nc); r[1] = f'{year}년 {mon}월 Daily Target 오일양 및 수거양 (AUTO)'; rows.append(r)
    rows.append(er(nc))
    r = er(nc); r[1] = f'{year}년 {mon}월 오일 계약 양:'; rows.append(r)
    r = er(nc); r[1] = 'Total Unloading 필요한 양:'; rows.append(r)
    for wi in range(len(weeks)):
        r = er(nc)
        if wi == 0: r[1] = 'Target\n오일양'
        r[2] = f'Week {wi+1}'; rows.append(r)
    rows.append(er(nc))
    rows.append(header)

    drv_starts = {}
    for driver in DRIVER_ORDER:
        region = DRIVER_REGION.get(driver, '')
        label = f'{driver}\n({region})' if region else driver
        tr=er(nc); ar=er(nc); vr=er(nc); hr=er(nc)
        tr[1]=label; tr[2]='Target 양'
        ar[2]='실제 수거양'; vr[2]='방문수'; hr[2]='Working Hrs'
        drv_starts[driver] = len(rows)

        for wi, wd in enumerate(weeks):
            wt=wac=wv=wh=0
            for day in wd:
                ds=day.strftime('%Y-%m-%d'); c=col_map[ds]
                d=mis_daily.get((ds,driver))
                if d:
                    tgt=locked_targets.get((ds,driver), d['forecast'])
                    tr[c]=tgt; ar[c]=d['actual']; vr[c]=d['stops']
                    h=d['hours']
                    if h: hr[c]=round(h,2); wh+=h
                    wt+=tgt; wac+=d['actual']; wv+=d['stops']
            wc=wtc[wi+1]
            tr[wc]=wt; ar[wc]=wac; vr[wc]=wv
            if wh: hr[wc]=round(wh,2)

        mt=sum(locked_targets.get((day.strftime('%Y-%m-%d'),driver),mis_daily.get((day.strftime('%Y-%m-%d'),driver),{}).get('forecast',0)) for w in weeks for day in w)
        ma=sum(mis_daily.get((day.strftime('%Y-%m-%d'),driver),{}).get('actual',0) for w in weeks for day in w)
        mv=sum(mis_daily.get((day.strftime('%Y-%m-%d'),driver),{}).get('stops',0) for w in weeks for day in w)
        mh=sum(mis_daily.get((day.strftime('%Y-%m-%d'),driver),{}).get('hours',0) or 0 for w in weeks for day in w)
        tr[total_col]=mt; ar[total_col]=ma; vr[total_col]=mv
        hr[total_col]=round(mh,2) if mh else ''
        rows+=[tr,ar,vr,hr]

    # TOTAL 행
    tt=er(nc); ta=er(nc); tm=er(nc)
    tt[1]='TOTAL'; tt[2]='Target 양'; ta[2]='실제 수거양(L)'; tm[2]='(Mton)'
    for wi,wd in enumerate(weeks):
        wc=wtc[wi+1]
        for day in wd:
            ds=day.strftime('%Y-%m-%d'); c=col_map[ds]
            tt[c]=sum(locked_targets.get((ds,d),mis_daily.get((ds,d),{}).get('forecast',0)) for d in DRIVER_ORDER)
            ta[c]=sum(mis_daily.get((ds,d),{}).get('actual',0) for d in DRIVER_ORDER)
            tm[c]=round(ta[c]/1099,2)
        tt[wc]=sum(locked_targets.get((day.strftime('%Y-%m-%d'),d),mis_daily.get((day.strftime('%Y-%m-%d'),d),{}).get('forecast',0)) for day in wd for d in DRIVER_ORDER)
        ta[wc]=sum(mis_daily.get((day.strftime('%Y-%m-%d'),d),{}).get('actual',0) for day in wd for d in DRIVER_ORDER)
        tm[wc]=round(ta[wc]/1099,2)
    m_act=sum(mis_daily.get((day.strftime('%Y-%m-%d'),d),{}).get('actual',0) for w in weeks for day in w for d in DRIVER_ORDER)
    m_tgt=sum(locked_targets.get((day.strftime('%Y-%m-%d'),d),mis_daily.get((day.strftime('%Y-%m-%d'),d),{}).get('forecast',0)) for w in weeks for day in w for d in DRIVER_ORDER)
    tt[total_col]=m_tgt; ta[total_col]=m_act; tm[total_col]=round(m_act/1099,2)
    rows+=[tt,ta,tm]
    r=er(nc); r[1]=f'{mon}월 총 수거양'; r[2]=round(m_act/1099,2); rows.append(r)

    # 시트 업데이트
    try: sh.del_worksheet(sh.worksheet(tab_name))
    except: pass
    ws = sh.add_worksheet(title=tab_name, rows=len(rows)+5, cols=nc+2)
    ws.update('A1', rows)
    time.sleep(3)

    # 포맷
    DB=Color(0.122,0.278,0.529); MB=Color(0.224,0.42,0.698)
    LB=Color(0.812,0.886,0.953); LG=Color(0.851,0.918,0.827)
    LY=Color(1.0,0.976,0.816);   WT=Color(0.671,0.741,0.812)
    OR=Color(0.937,0.608,0.224); WH=Color(1,1,1); GR=Color(0.88,0.88,0.88)
    BK=Color(0,0,0); LK=Color(0.98,0.92,0.84)

    def cf(bg=None,bold=False,fg=BK,size=10,ha='CENTER',wrap='OVERFLOW_CELL'):
        return CellFormat(backgroundColor=bg,
            textFormat=TextFormat(bold=bold,foregroundColor=fg,fontSize=size),
            horizontalAlignment=ha, wrapStrategy=wrap)

    b1=[]
    b1.append((f'A1:{col_letter(nc)}{len(rows)}', cf(bg=WH,ha='CENTER')))
    b1.append(('A1:'+col_letter(nc)+'1', cf(bg=DB,bold=True,fg=WH,size=12,ha='LEFT')))
    b1.append((f'A11:{col_letter(nc)}11', cf(bg=DB,bold=True,fg=WH,size=9)))
    for wi in range(1,len(weeks)+1):
        b1.append((f'{col_letter(wtc[wi])}11', cf(bg=WT,bold=True,fg=WH,size=9)))
        b1.append((f'{col_letter(woc[wi])}11', cf(bg=Color(0.5,0.5,0.5),bold=True,fg=WH,size=9)))
    b1.append((f'{col_letter(total_col)}11', cf(bg=OR,bold=True,fg=WH,size=9)))

    b2=[]
    all_days_in_month = [day for w in weeks for day in w]
    for driver in DRIVER_ORDER:
        sr=drv_starts[driver]+1
        tr,ar,vr,hr=sr,sr+1,sr+2,sr+3
        b1.append((f'B{tr}', cf(bg=MB,bold=True,fg=WH,ha='LEFT',wrap='WRAP')))
        for row in [tr,ar,vr,hr]:
            b1.append((f'C{row}', cf(bg=GR,bold=True,ha='LEFT')))
        b1.append((f'D{tr}:{col_letter(nc)}{tr}', cf(bg=LB)))
        b1.append((f'D{ar}:{col_letter(nc)}{ar}', cf(bg=LG)))
        b1.append((f'D{hr}:{col_letter(nc)}{hr}', cf(bg=LY)))
        for wi in range(1,len(weeks)+1):
            wc=col_letter(wtc[wi])
            b1.append((f'{wc}{tr}', cf(bg=WT,bold=True)))
            b1.append((f'{wc}{ar}', cf(bg=WT,bold=True)))
        b1.append((f'{col_letter(total_col)}{tr}', cf(bg=OR,bold=True,fg=WH)))
        b1.append((f'{col_letter(total_col)}{ar}', cf(bg=OR,bold=True,fg=WH)))
        # 8시 잠금값 셀 표시
        for day in all_days_in_month:
            ds=day.strftime('%Y-%m-%d')
            if (ds,driver) in locked_targets:
                b1.append((f'{col_letter(col_map[ds])}{tr}', cf(bg=LK,bold=True)))
        b2.append((f'D{tr}:{col_letter(nc)}{tr}', CellFormat(numberFormat=NumberFormat(type='NUMBER',pattern='#,##0'))))
        b2.append((f'D{ar}:{col_letter(nc)}{ar}', CellFormat(numberFormat=NumberFormat(type='NUMBER',pattern='#,##0'))))
        b2.append((f'D{hr}:{col_letter(nc)}{hr}', CellFormat(numberFormat=NumberFormat(type='NUMBER',pattern='0.00'))))

    tot_s=len(rows)-3
    for r in range(tot_s,tot_s+3):
        b1.append((f'A{r}:{col_letter(nc)}{r}', cf(bg=OR,bold=True,fg=WH)))
        b2.append((f'D{r}:{col_letter(nc)}{r}', CellFormat(numberFormat=NumberFormat(type='NUMBER',pattern='#,##0'))))

    format_cell_ranges(ws, b1); time.sleep(5)
    format_cell_ranges(ws, b2); time.sleep(3)

    set_column_width(ws,'A',30); set_column_width(ws,'B',120); set_column_width(ws,'C',90)
    time.sleep(2)
    for c in range(3,nc):
        cl=col_letter(c)
        if c in wtc.values() or c==total_col: set_column_width(ws,cl,80)
        elif c in woc.values(): set_column_width(ws,cl,48)
        else: set_column_width(ws,cl,52)
        time.sleep(0.2)

    set_row_height(ws,'1',35); set_row_height(ws,'11',28)
    ws.freeze(rows=11,cols=3)
    print(f"  ✅ '{tab_name}' 탭 업데이트 완료")

# ── 메인 ─────────────────────────────────────────────────────────
def main():
    print(f"\n{'='*50}")
    print(f"UCO Data Update - {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print('='*50)

    # JSON 로드
    with open(JSON_PATH, encoding='utf-8') as f:
        json_data = json.load(f)

    # 업데이트할 날짜 계산
    dates = get_update_dates(json_data)
    if not dates:
        print("✅ JSON은 최신 상태입니다. Google Sheets만 업데이트합니다.")
        _rebuild_current_month_sheet(json_data)
        return

    print(f"\n업데이트 날짜: {dates[0]} ~ {dates[-1]} ({len(dates)}일)")

    # 데이터 수집
    print("\n[1] MIS API 수거 데이터 수집...")
    mis_daily = fetch_mis_data(dates)

    print("\n[2] 8시 잠금 타겟 수집...")
    locked_targets = fetch_locked_targets(dates)

    # JSON 업데이트
    print("\n[3] uco_history.json 업데이트...")
    json_data = update_json(json_data, dates, mis_daily, locked_targets)
    with open(JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(json_data, f, ensure_ascii=False, separators=(',',':'))
    print(f"  저장 완료: {JSON_PATH}")

    # Google Sheets 업데이트 — 업데이트된 월 전체 데이터를 JSON에서 읽어서 사용
    print("\n[4] Google Sheets 업데이트...")
    months = sorted(set((d.year, d.month) for d in dates))

    for year, mon in months:
        ym_prefix = f"{year}-{mon:02d}"
        month_records = [r for r in json_data['daily'] if r['date'].startswith(ym_prefix)]
        full_mis = {}
        full_locked = {}
        for r in month_records:
            key = (r['date'], r['name'])
            full_mis[key] = {
                'init': r.get('init', ''), 'region': r.get('region', ''),
                'actual': r.get('actual', 0), 'stops': r.get('visits', 0),
                'hours': r.get('hours'), 'forecast': r.get('target', 0),
            }
            full_locked[key] = locked_targets.get(key, r.get('target', 0))
        print(f"  {ym_prefix} 시트 재구성: {len(month_records)}건")
        update_google_sheets_month(year, mon, full_mis, full_locked)

    print(f"\n{'='*50}")
    print("✅ 전체 업데이트 완료!")
    print('='*50)

if __name__ == '__main__':
    main()
