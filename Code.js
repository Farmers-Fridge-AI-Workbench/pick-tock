// ─── PICK TOCK ⏱️ — Code.gs ───────────────────────────────────────────────────
// Google Apps Script server-side code
// Deploy as Web App: Execute as "Me", Who has access = "Anyone in Farmer's Fridge"

const FORECAST_SHEET_ID = '1wyHr4QhvRGfyHgYURY7k5vLJFrpV3AX_wo5hkkk151A';
const FORECAST_TAB      = 'Pick Pack Forecast';
const STORAGE_KEY       = 'picktock_state';
const CPT_KEY           = 'picktock_cpts';
const LABOR_RATE_KEY    = 'picktock_last_hourly_rate';

// Admin emails — add/remove to grant/revoke access
const ADMINS = [
  'cori.blackburn@farmersfridge.com',
  'mfuoco@farmersfridge.com',
];

// Default approvers per department — stored in Script Properties as 'picktock_approvers'
const DEFAULT_APPROVERS = {
  planning:  [],
  pickpack:  ['johnathan.sherod@farmersfridge.com','deonte.johnson@farmersfridge.com','matthew.smith@farmersfridge.com'],
  logistics: ['jrubinstein@farmersfridge.com','ahopkins@farmersfridge.com'],
};

const MARKET_LH_MAP = {
  'Austin':         'S (DAL, HOU, AUS, SAT)',
  'Boston':         'NE',
  'Chicago':        'IL PM',
  'Cincinnati':     'INDY (IND, OH)',
  'Cleveland':      'MI',
  'Columbus':       'INDY (IND, OH)',
  'Dallas':         'S (DAL, HOU, AUS, SAT)',
  'DC / Baltimore': 'NE',
  'Detroit':        'MI',
  'Houston':        'S (DAL, HOU, AUS, SAT)',
  'Indianapolis':   'INDY (IND, OH)',
  'Las Vegas':      'W (LA, SD)',
  'Los Angeles':    'W (LA, SD)',
  'Milwaukee':      'WI (MKE, MAD)',
  'Minneapolis':    'MN',
  'Nashville':      'TN',
  'New Jersey':     'NE',
  'New York City':  'NE',
  'Philadelphia':   'NE',
  'Pittsburgh':     'MI',
  'San Antonio':    'S (DAL, HOU, AUS, SAT)',
  'San Diego':      'W (LA, SD)',
  'St. Louis':      'STL',
};

const DAYS_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

// ─── SERVE UI ─────────────────────────────────────────────────────────────────

function doGet(e) {
  return HtmlService
    .createHtmlOutputFromFile('Index')
    .setTitle('Pick Tock ⏱️')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

function getCurrentUser() {
  const email = Session.getActiveUser().getEmail();
  const admins = getAdminUsers();
  const isAdmin = admins.map(a => a.toLowerCase()).includes(email.toLowerCase());
  const approvers = getApproverUsers();
  const approverDepts = [];
  Object.entries(approvers).forEach(([dept, emails]) => {
    if (emails.map(e => e.toLowerCase()).includes(email.toLowerCase())) {
      approverDepts.push(dept);
    }
  });
  // Planning approvers get access to all three depts
  if (approverDepts.includes('planning')) {
    ['pickpack','logistics'].forEach(d => { if (!approverDepts.includes(d)) approverDepts.push(d); });
  }
  return {
    email,
    isAdmin,
    name: email.split('@')[0],
    approverDepts,
  };
}

function getApproverUsers() {
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty('picktock_approvers');
  try { return stored ? JSON.parse(stored) : DEFAULT_APPROVERS; } catch(e) { return DEFAULT_APPROVERS; }
}

function saveApproverUsers(approverUsers) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');
  PropertiesService.getScriptProperties().setProperty('picktock_approvers', JSON.stringify(approverUsers));
  return { ok: true };
}

// ─── STATE STORAGE ────────────────────────────────────────────────────────────

function getState() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(STORAGE_KEY);
  let state = null;
  try { state = raw ? JSON.parse(raw) : null; } catch(e) { state = null; }
  if (!state) return null;
  // Always load CPTs from their own isolated key
  const cptRaw = props.getProperty(CPT_KEY);
  try { state.cptOverrides = cptRaw ? JSON.parse(cptRaw) : {}; } catch(e) { state.cptOverrides = {}; }
  // If laborConfig or its rate is missing, backfill from the last-saved rate (not a stale hardcoded default)
  if (!state.laborConfig || typeof state.laborConfig.hourlyRate !== 'number') {
    const lastRate = parseFloat(props.getProperty(LABOR_RATE_KEY));
    const fallbackRate = isNaN(lastRate) ? 24.39 : lastRate;
    state.laborConfig = Object.assign({ empPerLine: 12, replenisher: 2, leads: 2, boxBuilders: 2 }, state.laborConfig || {}, { hourlyRate: fallbackRate });
  }
  return state;
}

function saveState(state) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');
  state.lastModified = new Date().toISOString();
  // Keep the persisted "last known rate" in sync any time labor config is saved
  if (state.laborConfig && typeof state.laborConfig.hourlyRate === 'number') {
    PropertiesService.getScriptProperties().setProperty(LABOR_RATE_KEY, String(state.laborConfig.hourlyRate));
  }
  // Strip cptOverrides before writing main state — CPTs have their own key
  const stateToSave = Object.assign({}, state);
  delete stateToSave.cptOverrides;
  PropertiesService.getScriptProperties().setProperty(STORAGE_KEY, JSON.stringify(stateToSave));
  return { ok: true };
}

// ─── SYNC / POLLING ───────────────────────────────────────────────────────────

function getLastModified() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(STORAGE_KEY);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    return state.lastModified || null;
  } catch(e) { return null; }
}

// ─── PER-DAY LEVERS ───────────────────────────────────────────────────────────

function saveDayLevers(weekLabel, day, levers) {
  const user = getCurrentUser();

  let state = getState() || { demands: {} };
  if (!state.demands) state.demands = {};
  if (!state.demands[weekLabel]) state.demands[weekLabel] = {};
  if (!state.demands[weekLabel][day]) {
    state.demands[weekLabel][day] = {};
  }

  const existing = state.demands[weekLabel][day].levers || {};

  const isPickPack = user.approverDepts && user.approverDepts.includes('pickpack');
  const allocStart = (user.isAdmin || isPickPack)
    ? (levers.allocStart !== undefined ? levers.allocStart : existing.allocStart)
    : existing.allocStart;

  const newLevers = {
    uph:          levers.uph          !== undefined ? levers.uph          : existing.uph,
    pickStart:    levers.pickStart    !== undefined ? levers.pickStart    : existing.pickStart,
    allocStart:   allocStart,
    includeBreak: levers.includeBreak !== undefined ? levers.includeBreak : (existing.includeBreak !== undefined ? existing.includeBreak : true),
    break30:      levers.break30      !== undefined ? levers.break30      : (existing.break30      !== undefined ? existing.break30      : { enabled: true, time: null }),
    break15:      levers.break15      !== undefined ? levers.break15      : (existing.break15      !== undefined ? existing.break15      : { enabled: true, time: null }),
  };

  ['uph','pickStart','allocStart','includeBreak'].forEach(f => {
    if (newLevers[f] !== undefined && existing[f] !== undefined && newLevers[f] !== existing[f]) {
      writeAuditLog(user.email, 'lever_change', f, existing[f], newLevers[f], weekLabel, day);
    }
  });

  state.demands[weekLabel][day].levers = newLevers;
  state.lastModified = new Date().toISOString();
  // Strip CPTs before writing
  const stateToSave = Object.assign({}, state);
  delete stateToSave.cptOverrides;
  PropertiesService.getScriptProperties().setProperty(STORAGE_KEY, JSON.stringify(stateToSave));
  return { ok: true };
}

// ─── HOLIDAY OVERRIDE ─────────────────────────────────────────────────────────

function saveDayHolidayOverride(weekLabel, day, override) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');
  let state = getState() || { demands: {} };
  if (!state.demands) state.demands = {};
  if (!state.demands[weekLabel]) state.demands[weekLabel] = {};
  if (!state.demands[weekLabel][day]) state.demands[weekLabel][day] = {};
  const wasActive = !!(state.demands[weekLabel][day].holidayOverride && state.demands[weekLabel][day].holidayOverride.active);
  const nowActive = !!(override && override.active);
  if (wasActive !== nowActive) {
    writeAuditLog(user.email, 'holiday_override', 'active', wasActive, nowActive, weekLabel, day);
  }
  if (nowActive) {
    writeAuditLog(user.email, 'holiday_override', 'lines', wasActive ? (state.demands[weekLabel][day].holidayOverride.lines || '') : '', override.lines, weekLabel, day);
  }
  state.demands[weekLabel][day].holidayOverride = override;
  state.lastModified = new Date().toISOString();
  const stateToSave = Object.assign({}, state);
  delete stateToSave.cptOverrides;
  PropertiesService.getScriptProperties().setProperty(STORAGE_KEY, JSON.stringify(stateToSave));
  return { ok: true };
}

// ─── FORECAST FETCH ───────────────────────────────────────────────────────────

function getAvailableForecastWeeks() {
  const ss = SpreadsheetApp.openById(FORECAST_SHEET_ID);
  const sheet = ss.getSheetByName(FORECAST_TAB);
  if (!sheet) throw new Error('Tab "' + FORECAST_TAB + '" not found');

  const row2 = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row3 = sheet.getRange(3, 1, 1, sheet.getLastColumn()).getValues()[0];

  const weeks = {};
  row2.forEach((cell, ci) => {
    const wkNum = parseInt(cell);
    if (!wkNum) return;
    const dayName = String(row3[ci]).trim();
    if (!DAYS_ORDER.includes(dayName)) return;
    const year = new Date().getFullYear();
    const wkLabel = 'W' + String(wkNum).padStart(2,'0') + '-' + year;
    if (!weeks[wkLabel]) weeks[wkLabel] = { label: wkLabel, wkNum, days: [] };
    weeks[wkLabel].days.push(dayName);
  });

  return Object.values(weeks).sort((a,b) => a.wkNum - b.wkNum);
}

function fetchForecastWeek(weekLabel) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');

  const ss = SpreadsheetApp.openById(FORECAST_SHEET_ID);
  const sheet = ss.getSheetByName(FORECAST_TAB);
  if (!sheet) throw new Error('Tab "' + FORECAST_TAB + '" not found');

  const lastCol = sheet.getLastColumn();
  const row2 = sheet.getRange(2, 1, 1, lastCol).getValues()[0];
  const row3 = sheet.getRange(3, 1, 1, lastCol).getValues()[0];
  const row4 = sheet.getRange(4, 1, 1, lastCol).getValues()[0];

  const wkNum = parseInt(weekLabel.replace('W','').split('-')[0]);

  const weekCols = [];
  row2.forEach((cell, ci) => {
    if (parseInt(cell) !== wkNum) return;
    const dayName = String(row3[ci]).trim();
    if (!DAYS_ORDER.includes(dayName)) return;
    const dateVal = row4[ci];
    const dateStr = dateVal instanceof Date
      ? Utilities.formatDate(dateVal, Session.getScriptTimeZone(), 'yyyy-MM-dd')
      : '';
    weekCols.push({ col: ci, day: dayName, date: dateStr });
  });

  if (!weekCols.length) throw new Error('Week ' + weekLabel + ' not found or no day columns matched');

  const marketStartRow = 10;
  const allData = sheet.getDataRange().getValues();

  const lhTotals = {};
  const dates = {};
  weekCols.sort((a,b) => DAYS_ORDER.indexOf(a.day) - DAYS_ORDER.indexOf(b.day));
  weekCols.forEach(wc => { lhTotals[wc.day] = {}; dates[wc.day] = wc.date; });

  const storedState = getState();
  const chicagoSplit = storedState?.chicagoSplit || { ilPm: 0.60, ilAm: 0.40 };

  const seenMarkets = new Set();
  for (let r = marketStartRow; r < allData.length; r++) {
    const market = String(allData[r][2]).trim();
    if (seenMarkets.has(market)) continue;
    seenMarkets.add(market);
    const lh = MARKET_LH_MAP[market];
    if (!lh && market !== 'Chicago') continue;

    weekCols.forEach(wc => {
      const raw = allData[r][wc.col] != null ? String(allData[r][wc.col]).replace(/,/g, '') : '0';
      const vol = Math.round(parseFloat(raw) || 0);
      if (vol <= 0) return;

      if (market === 'Chicago') {
        const pmVol = Math.round(vol * chicagoSplit.ilPm);
        const amVol = vol - pmVol;
        lhTotals[wc.day]['IL PM'] = (lhTotals[wc.day]['IL PM'] || 0) + pmVol;
        lhTotals[wc.day]['IL AM'] = (lhTotals[wc.day]['IL AM'] || 0) + amVol;
      } else {
        lhTotals[wc.day][lh] = (lhTotals[wc.day][lh] || 0) + vol;
      }
    });
  }

  return { lhTotals, dates, weekLabel, mode: 'forecast' };
}

// ─── MARKET → LINEHAUL MAP (single source of truth — client fetches this, does not hardcode its own copy) ──
function getMarketLhMap() {
  return MARKET_LH_MAP;
}

// ─── FETCH & PUBLISH ALL FORECAST WEEKS ──────────────────────────────────────

function fetchAndPublishAllForecastWeeks() {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');

  const weeks = getAvailableForecastWeeks();
  if (!weeks.length) throw new Error('No forecast weeks found');

  let state = getState() || { demands: {}, lhSchedule: null, thruputs: null, cptOverrides: {} };
  if (!state.demands) state.demands = {};

  const chicagoSplit = state.chicagoSplit || { ilPm: 0.60, ilAm: 0.40 };

  const ss = SpreadsheetApp.openById(FORECAST_SHEET_ID);
  const sheet = ss.getSheetByName(FORECAST_TAB);
  if (!sheet) throw new Error('Tab "' + FORECAST_TAB + '" not found');

  const lastCol = sheet.getLastColumn();
  const row2 = sheet.getRange(2, 1, 1, lastCol).getValues()[0];
  const row3 = sheet.getRange(3, 1, 1, lastCol).getValues()[0];
  const row4 = sheet.getRange(4, 1, 1, lastCol).getValues()[0];
  const allData = sheet.getDataRange().getValues();
  const marketStartRow = 10;

  let totalDays = 0, skippedDays = 0;

  weeks.forEach(({ label: weekLabel, wkNum }) => {
    const weekCols = [];
    row2.forEach((cell, ci) => {
      if (parseInt(cell) !== wkNum) return;
      const dayName = String(row3[ci]).trim();
      if (!DAYS_ORDER.includes(dayName)) return;
      const dateVal = row4[ci];
      const dateStr = dateVal instanceof Date
        ? Utilities.formatDate(dateVal, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : '';
      weekCols.push({ col: ci, day: dayName, date: dateStr });
    });
    if (!weekCols.length) return;

    const lhTotals = {}, dates = {};
    weekCols.sort((a,b) => DAYS_ORDER.indexOf(a.day) - DAYS_ORDER.indexOf(b.day));
    weekCols.forEach(wc => { lhTotals[wc.day] = {}; dates[wc.day] = wc.date; });

    const seenMarkets = new Set();
    for (let r = marketStartRow; r < allData.length; r++) {
      const market = String(allData[r][2]).trim();
      if (seenMarkets.has(market)) continue;
      seenMarkets.add(market);
      const lh = MARKET_LH_MAP[market];
      if (!lh && market !== 'Chicago') continue;

      weekCols.forEach(wc => {
        const raw = allData[r][wc.col] != null ? String(allData[r][wc.col]).replace(/,/g, '') : '0';
        const vol = Math.round(parseFloat(raw) || 0);
        if (vol <= 0) return;
        if (market === 'Chicago') {
          const pmVol = Math.round(vol * chicagoSplit.ilPm);
          const amVol = vol - pmVol;
          lhTotals[wc.day]['IL PM'] = (lhTotals[wc.day]['IL PM'] || 0) + pmVol;
          lhTotals[wc.day]['IL AM'] = (lhTotals[wc.day]['IL AM'] || 0) + amVol;
        } else {
          lhTotals[wc.day][lh] = (lhTotals[wc.day][lh] || 0) + vol;
        }
      });
    }

    if (!state.demands[weekLabel]) state.demands[weekLabel] = {};

    Object.entries(lhTotals).forEach(([day, volByLH]) => {
      const existing = state.demands[weekLabel][day];
      if (existing && existing.mode === 'actual') { skippedDays++; return; }

      let history = [];
      if (existing) {
        history = existing.history || [];
        history.unshift({ vol: existing.vol, mode: existing.mode, date: existing.date, publishedBy: existing.publishedBy || '', publishedAt: existing.publishedAt || '', savedAt: new Date().toISOString() });
        history = history.slice(0, 5);
      }

      state.demands[weekLabel][day] = Object.assign({}, existing, {
        vol:         volByLH,
        mode:        'forecast',
        date:        dates[day] || existing?.date || '',
        publishedBy: user.email,
        publishedAt: new Date().toISOString(),
        locked:      true,
        history,
      });
      totalDays++;
    });
  });

  writeAuditLog(user.email, 'publish', 'week', '', 'ALL (' + weeks.length + ' weeks, forecast)', '', '');
  saveState(state);
  logPublish(user.email, 'ALL (' + weeks.length + ' weeks)', 'forecast');

  return { ok: true, weeksLoaded: weeks.length, daysLoaded: totalDays, daysSkipped: skippedDays };
}

// ─── PUBLISH ──────────────────────────────────────────────────────────────────

function publishWeek(weekLabel, lhTotals, dates, mode, rawPaste, levelLoadedLHs) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');

  let state = getState() || { demands: {}, lhSchedule: null, thruputs: null, cptOverrides: {} };
  if (!state.demands) state.demands = {};
  if (!state.demands[weekLabel]) state.demands[weekLabel] = {};

  Object.entries(lhTotals).forEach(([day, volByLH]) => {
    const existing = state.demands[weekLabel][day];
    if (existing && existing.mode === 'actual' && mode === 'forecast') return;

    let history = [];
    if (existing) {
      history = existing.history || [];
      history.unshift({ vol: existing.vol, mode: existing.mode, date: existing.date, publishedBy: existing.publishedBy || '', publishedAt: existing.publishedAt || '', savedAt: new Date().toISOString() });
      history = history.slice(0, 5);
    }

    const overrides = {
      vol:         volByLH,
      mode,
      date:        dates[day] || existing?.date || '',
      publishedBy: user.email,
      publishedAt: new Date().toISOString(),
      locked:      true,
      history,
    };
    if (levelLoadedLHs && levelLoadedLHs[day] !== undefined) overrides.levelLoadedLHs = levelLoadedLHs[day];
    state.demands[weekLabel][day] = Object.assign({}, existing, overrides);
  });

  writeAuditLog(user.email, 'publish', 'week', '', weekLabel + ' (' + mode + ')', weekLabel, '');
  if (mode === 'actual' && rawPaste) {
    logRawPasteData(user.email, weekLabel, Object.keys(lhTotals).join(', '), rawPaste);
  }
  saveState(state);
  logPublish(user.email, weekLabel, mode);
  return { ok: true, weekLabel, days: Object.keys(lhTotals).length };
}

// ─── UNDO ─────────────────────────────────────────────────────────────────────

function undoDayPublish(weekLabel, day) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');

  let state = getState();
  if (!state) throw new Error('No state found');

  const dayData = state.demands?.[weekLabel]?.[day];
  if (!dayData) throw new Error('No data found for ' + weekLabel + ' ' + day);

  const history = dayData.history || [];
  if (!history.length) throw new Error('No undo history for ' + day);

  const prev = history.shift();

  writeAuditLog(user.email, 'undo', 'week/day', dayData.mode, prev.mode, weekLabel, day);

  state.demands[weekLabel][day] = Object.assign({}, dayData, {
    vol:         prev.vol,
    mode:        prev.mode,
    date:        prev.date,
    publishedBy: prev.publishedBy || '',
    publishedAt: prev.publishedAt || '',
    locked:      true,
    history,
  });

  saveState(state);
  return { ok: true, day, mode: prev.mode, stepsLeft: history.length };
}

// ─── ACTUAL THROUGHPUT FETCH ──────────────────────────────────────────────────

function fetchAndSaveThruputs() {
  const result = fetchActualThruputs();
  let state = getState() || {};
  if (!state.thruputs) state.thruputs = {};
  Object.assign(state.thruputs, result);
  state.thruputUpdatedAt = new Date().toISOString();
  const stateToSave = Object.assign({}, state);
  delete stateToSave.cptOverrides;
  PropertiesService.getScriptProperties().setProperty(STORAGE_KEY, JSON.stringify(stateToSave));
  Logger.log('Throughputs auto-updated: ' + JSON.stringify(result));
}

function fetchActualThruputs() {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');

  const sourceSheetId = '1WGBdj4_wk2PU4LvcpZcL_TeZSjrkpsJyuorQiK5d3WI';
  const sourceTabName = 'Data Main';
  const sheet = SpreadsheetApp.openById(sourceSheetId).getSheetByName(sourceTabName);
  if (!sheet) throw new Error('Data Main tab not found');

  const lastRow = sheet.getLastRow();
  const readRows = Math.min(lastRow, 200);
  const data = sheet.getRange(Math.max(1, lastRow - readRows), 1, readRows, 33).getValues();
  const today = new Date();
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(today.getDate() - 90);

  const dateCol = 2, thruputCol = 32;
  const buckets = {};
  DAYS_ORDER.forEach(day => buckets[day] = []);

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const dateVal = row[dateCol], thruput = row[thruputCol];
    if (!dateVal || !thruput || thruput === 0) continue;
    const date = new Date(dateVal);
    if (date < ninetyDaysAgo || date > today) continue;
    const dayName = Utilities.formatDate(date, Session.getScriptTimeZone(), 'EEEE');
    if (buckets[dayName] !== undefined) buckets[dayName].push(Number(thruput));
  }

  const result = {};
  DAYS_ORDER.forEach(day => {
    const values = buckets[day];
    if (values.length > 0) result[day] = Math.min(3000, Math.round(values.reduce((a,b) => a+b, 0) / values.length));
  });
  return result;
}

// ─── PUSH DEPARTURE TIMES ────────────────────────────────────────────────────

const DEPARTURE_SHEET_ID = '1J3_bJzxlYfAIrzzpPNE-cEi-VqArWVQyIuiiR1j_25E';
const DEPARTURE_TAB      = 'Import2.0';

function pushDepartureTimes() {
  const state = getState();
  if (!state || !state.demands) { Logger.log('pushDepartureTimes: no state'); return; }

  const tz = Session.getScriptTimeZone();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const targetDay = Utilities.formatDate(yesterday, tz, 'EEEE');
  const targetDate = Utilities.formatDate(yesterday, tz, 'yyyy-MM-dd');

  const weeks = Object.keys(state.demands).sort();
  let weekLabel = null;
  for (let i = weeks.length - 1; i >= 0; i--) {
    if (state.demands[weeks[i]][targetDay]) { weekLabel = weeks[i]; break; }
  }
  if (!weekLabel) { Logger.log('pushDepartureTimes: no data for ' + targetDay); return; }

  const dayData = state.demands[weekLabel][targetDay];
  const volByLH = dayData.vol || {};
  if (!Object.keys(volByLH).length) { Logger.log('pushDepartureTimes: empty volume for ' + targetDay); return; }

  const lhSchedule = state.lhSchedule || [];
  const cptOverrides = state.cptOverrides || {};
  const thruputs = state.thruputs || {};

  const savedLevers = dayData.levers || {};
  const hov = dayData.holidayOverride;
  const lines = (hov && hov.active && hov.lines)
    ? hov.lines
    : (state.lineThreshold && state.lineThreshold.length)
      ? (()=>{
          const total = Object.values(volByLH).reduce((s,v)=>s+v,0);
          const sorted = state.lineThreshold.slice().sort((a,b)=>b.vol-a.vol);
          for (const t of sorted) { if (total >= t.vol) return t.lines; }
          return (state.lines && state.lines[targetDay]) || 2;
        })()
      : (state.lines && state.lines[targetDay]) || 2;

  const uph       = savedLevers.uph        || thruputs[targetDay] || 2700;
  const pickStart = savedLevers.pickStart  || 16.5;
  const mwStart   = savedLevers.allocStart || 18.0;
  const startH    = Math.min(16, Math.floor(pickStart));

  const MIDWEST = new Set(lhSchedule.filter(l => l.group === 'MW').map(l => l.lh));

  function getCpt(lh) {
    if (hov && hov.active && hov.cpts && hov.cpts[lh] !== undefined) return hov.cpts[lh];
    if (cptOverrides[lh] !== undefined) return cptOverrides[lh];
    const entry = lhSchedule.find(l => l.lh === lh);
    return entry ? entry.cpt : 23;
  }

  const allTrucks = [];
  Object.entries(volByLH).forEach(([lh, vol]) => {
    if (vol > 0) allTrucks.push({ lh, vol, cpt: getCpt(lh) });
  });
  if (!allTrucks.length) return;

  const sortFn = (a, b) => a.cpt !== b.cpt ? a.cpt - b.cpt : b.vol - a.vol;
  const sortedTrucks = allTrucks.slice().sort(sortFn);
  const nonMwTrucks  = allTrucks.filter(t => !MIDWEST.has(t.lh)).sort(sortFn);

  const lineFree = Array(lines).fill(pickStart);
  const truckTe = {}, rem = {};
  allTrucks.forEach(t => rem[t.lh] = t.vol);

  function runSeg(lh, vol, floor) {
    if (vol <= 0) return;
    const hpl = (vol / lines) / uph;
    const si = Array.from({length: lines}, (_, i) => i)
      .sort((a, b) => Math.max(lineFree[a], floor) - Math.max(lineFree[b], floor));
    si.forEach(li => {
      const s = Math.max(lineFree[li], floor), e = s + hpl;
      lineFree[li] = e;
      if (truckTe[lh] === undefined || e > truckTe[lh]) truckTe[lh] = e;
    });
  }

  for (const t of nonMwTrucks) {
    const av = lineFree.reduce((s, f) => s + Math.max(0, mwStart - Math.max(f, pickStart)), 0);
    const vp = Math.min(rem[t.lh], av * uph);
    if (vp > 0.1) { runSeg(t.lh, vp, pickStart); rem[t.lh] -= vp; }
  }
  for (const t of sortedTrucks) {
    if (rem[t.lh] <= 0) continue;
    runSeg(t.lh, rem[t.lh], MIDWEST.has(t.lh) ? mwStart : pickStart);
    rem[t.lh] = 0;
  }

  function fmtTime(h) {
    const total = Math.round(h * 60), hh = Math.floor(total / 60) % 24, mm = total % 60;
    const ap = hh >= 12 ? 'PM' : 'AM';
    return (hh % 12 || 12) + ':' + String(mm).padStart(2, '0') + ' ' + ap;
  }
  function fmtTimePlus(h) { return h >= 24 ? fmtTime(h) + ' +1' : fmtTime(h); }

  const rows = allTrucks.map(t => {
    const cptA = t.cpt < startH ? t.cpt + 24 : t.cpt;
    return [targetDate, targetDay, t.lh, t.vol, fmtTimePlus(cptA - 1), fmtTimePlus(cptA)];
  }).sort((a, b) => a[2].localeCompare(b[2]));

  const ss = SpreadsheetApp.openById(DEPARTURE_SHEET_ID);
  const sheet = ss.getSheetByName(DEPARTURE_TAB);
  if (!sheet) { Logger.log('pushDepartureTimes: tab not found'); return; }
  if (sheet.getLastRow() === 0) sheet.appendRow(['Date', 'Day', 'Linehaul', 'Volume', 'Ideal Departure', 'CPT']);
  rows.forEach(row => sheet.appendRow(row));
  Logger.log('pushDepartureTimes: wrote ' + rows.length + ' rows for ' + targetDay + ' (' + weekLabel + ')');
}

// ─── SUPPORTING SAVES ─────────────────────────────────────────────────────────

function saveDayApproval(weekLabel, day, approvals) {
  const user = getCurrentUser();
  // Admins can save anything; dept approvers can save only their own scoped dept(s)
  if (!user.isAdmin) {
    const allowedDepts = user.approverDepts || [];
    const requestedDepts = Object.keys(approvals);
    const allAllowed = requestedDepts.every(dept => allowedDepts.includes(dept));
    if (!allAllowed) throw new Error('Not authorized to approve this department');
  }
  let state = getState() || { demands: {} };
  if (!state.demands) state.demands = {};
  if (!state.demands[weekLabel]) state.demands[weekLabel] = {};
  if (!state.demands[weekLabel][day]) state.demands[weekLabel][day] = {};
  // Merge — only overwrite depts included in this save, preserve others
  const existing = state.demands[weekLabel][day].approvals || {};
  Object.entries(approvals).forEach(([dept, val]) => {
    const wasApproved = !!(existing[dept] && existing[dept].approved);
    const nowApproved = !!(val && val.approved);
    writeAuditLog(
      user.email, 'approval', dept,
      wasApproved ? 'approved by ' + (existing[dept].approvedBy || '?') : 'not approved',
      nowApproved ? 'approved by ' + (val.approvedBy || '?') : 'unapproved',
      weekLabel, day
    );
  });
  state.demands[weekLabel][day].approvals = Object.assign({}, existing, approvals);
  state.lastModified = new Date().toISOString();
  const stateToSave = Object.assign({}, state);
  delete stateToSave.cptOverrides;
  PropertiesService.getScriptProperties().setProperty(STORAGE_KEY, JSON.stringify(stateToSave));
  return { ok: true };
}

function saveLhSchedule(lhSchedule) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');
  let state = getState() || {};
  state.lhSchedule = lhSchedule;
  writeAuditLog(user.email, 'lh_schedule_save', 'lhSchedule', '', lhSchedule.length + ' linehauls saved', '', '');
  saveState(state);
  return { ok: true };
}

function saveThruputs(thruputs) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');
  let state = getState() || {};
  state.thruputs = thruputs;
  saveState(state);
  return { ok: true };
}

function saveCptOverrides(overrides) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');
  try {
    const existing = JSON.parse(PropertiesService.getScriptProperties().getProperty(CPT_KEY) || '{}');
    Object.entries(overrides).forEach(([lh, val]) => {
      if (existing[lh] !== val) writeAuditLog(user.email, 'cpt_change', lh, existing[lh], val, '', '');
    });
  } catch(e) {}
  PropertiesService.getScriptProperties().setProperty(CPT_KEY, JSON.stringify(overrides));
  return { ok: true };
}

// ─── PIN MANAGEMENT ───────────────────────────────────────────────────────────

function getPin() {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty('picktock_pin') || '1234';
}

function setPin(currentPin, newPin) {
  const stored = getPin();
  if (currentPin !== stored) throw new Error('Current PIN is incorrect');
  if (!newPin || newPin.length < 4) throw new Error('New PIN must be at least 4 characters');
  PropertiesService.getScriptProperties().setProperty('picktock_pin', newPin);
  return { ok: true };
}

// ─── ADMIN USER MANAGEMENT ────────────────────────────────────────────────────

function getAdminUsers() {
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty('picktock_admins');
  return stored ? JSON.parse(stored) : ADMINS;
}

function addAdminUser(email) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');
  const admins = getAdminUsers();
  if (!admins.includes(email.toLowerCase())) admins.push(email.toLowerCase());
  PropertiesService.getScriptProperties().setProperty('picktock_admins', JSON.stringify(admins));
  return { ok: true };
}

function removeAdminUser(email) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');
  if (email.toLowerCase() === user.email.toLowerCase()) throw new Error("You can't remove yourself");
  const admins = getAdminUsers().filter(e => e.toLowerCase() !== email.toLowerCase());
  PropertiesService.getScriptProperties().setProperty('picktock_admins', JSON.stringify(admins));
  return { ok: true };
}

// ─── AUDIT LOG ────────────────────────────────────────────────────────────────

const AUDIT_LOG_SHEET_ID = '171MBi7ENBxNwaVwp4r6d-bIBhSCoKyPZiakB8snK6T4';

function logRawPasteData(email, weekLabel, days, rawPaste) {
  try {
    const ss = SpreadsheetApp.openById(AUDIT_LOG_SHEET_ID);
    let sheet = ss.getSheetByName('Paste Data Log');
    if (!sheet) {
      sheet = ss.insertSheet('Paste Data Log');
      sheet.appendRow(['Timestamp','Email','Week','Days','Raw Pasted Data']);
      sheet.getRange(1,1,1,5).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([new Date(), email || '', weekLabel || '', days || '', rawPaste || '']);
  } catch(e) {
    Logger.log('Paste data log write failed: ' + e.message);
  }
}

function writeAuditLog(email, action, field, oldVal, newVal, week, day) {
  try {
    const ss = SpreadsheetApp.openById(AUDIT_LOG_SHEET_ID);
    let sheet = ss.getSheetByName('Audit Log');
    if (!sheet) {
      sheet = ss.insertSheet('Audit Log');
      sheet.appendRow(['Timestamp','Email','Action','Field','Old Value','New Value','Week','Day']);
      sheet.getRange(1,1,1,8).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([
      new Date(),
      email || '',
      action || '',
      field || '',
      oldVal !== undefined && oldVal !== null ? String(oldVal) : '',
      newVal !== undefined && newVal !== null ? String(newVal) : '',
      week || '',
      day || '',
    ]);
  } catch(e) {
    Logger.log('Audit log write failed: ' + e.message);
  }
}

function getAuditLog() {
  const user = getCurrentUser();
  const viewers = getAuditViewers();
  const allAllowed = [user.email.toLowerCase(), ...viewers.map(e => e.toLowerCase())];
  if (!user.isAdmin && !allAllowed.includes(user.email.toLowerCase())) throw new Error('Not authorized');
  try {
    const ss = SpreadsheetApp.openById(AUDIT_LOG_SHEET_ID);
    const sheet = ss.getSheetByName('Audit Log');
    if (!sheet || sheet.getLastRow() <= 1) return [];
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues();
    return rows.reverse().slice(0, 100).map(r => ({
      timestamp: r[0] ? new Date(r[0]).toLocaleString('en-US', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit',hour12:true}) : '',
      email: r[1], action: r[2], field: r[3], oldVal: r[4], newVal: r[5], week: r[6], day: r[7],
    }));
  } catch(e) { return []; }
}

function getAuditViewers() {
  const props = PropertiesService.getScriptProperties();
  try { return JSON.parse(props.getProperty('picktock_audit_viewers') || '[]'); } catch(e) { return []; }
}

function saveAuditViewers(viewers) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');
  PropertiesService.getScriptProperties().setProperty('picktock_audit_viewers', JSON.stringify(viewers));
  return { ok: true };
}

function logPublish(email, weekLabel, mode) {
  try {
    const ss = SpreadsheetApp.openById(AUDIT_LOG_SHEET_ID);
    let logSheet = ss.getSheetByName('Publish Log');
    if (!logSheet) {
      logSheet = ss.insertSheet('Publish Log');
      logSheet.appendRow(['Timestamp', 'User', 'Week', 'Mode', 'Action']);
      logSheet.getRange(1,1,1,5).setFontWeight('bold');
      logSheet.setFrozenRows(1);
    }
    logSheet.appendRow([new Date(), email, weekLabel, mode, 'publish']);
  } catch(e) {
    // Log sheet is optional — don't fail publish if it errors
  }
}

// ─── ONE-TIME MIGRATION: split Chicago IL PM → IL PM + IL AM ─────────────────

function migrateChicagoSplit() {
  const state = getState();
  if (!state || !state.demands) { Logger.log('No state to migrate'); return; }

  const chicagoSplit = state.chicagoSplit || { ilPm: 0.60, ilAm: 0.40 };
  let fixed = 0;

  Object.entries(state.demands).forEach(([week, days]) => {
    Object.entries(days).forEach(([day, dayData]) => {
      const vol = dayData.vol;
      if (!vol) return;
      if (vol['IL AM']) return;
      if (!vol['IL PM']) return;
      const total = vol['IL PM'];
      const pmVol = Math.round(total * chicagoSplit.ilPm);
      const amVol = total - pmVol;
      vol['IL PM'] = pmVol;
      vol['IL AM'] = amVol;
      Logger.log('Fixed ' + week + ' ' + day + ': IL PM=' + pmVol + ' IL AM=' + amVol);
      fixed++;
    });
  });

  if (fixed === 0) { Logger.log('Nothing to migrate — all days already have IL AM or no Chicago data'); return; }
  state.lastModified = new Date().toISOString();
  const stateToSave = Object.assign({}, state);
  delete stateToSave.cptOverrides;
  PropertiesService.getScriptProperties().setProperty(STORAGE_KEY, JSON.stringify(stateToSave));
  Logger.log('Migration complete — fixed ' + fixed + ' days');
}

// ─── FEATURE REQUESTS ────────────────────────────────────────────────────────

const FEATURE_REQUEST_SHEET_ID = '1Iq7zLni2tIRv5sjePRedSyvNQI1ecPiARA4P1vod948';

function submitFeatureRequest(data) {
  const ss = SpreadsheetApp.openById(FEATURE_REQUEST_SHEET_ID);
  let sheet = ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Timestamp', 'Email', 'Date', 'Request', 'Urgency']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
  }
  sheet.appendRow([
    new Date(),
    data.email   || '',
    data.date    || '',
    data.request || '',
    data.urgency || '',
  ]);
  return { ok: true };
}

function getCurrentUserEmail() {
  return Session.getActiveUser().getEmail();
}
// ─── DAY NOTES ────────────────────────────────────────────────────────────────

function saveDayNote(weekLabel, day, text) {
  const user = getCurrentUser();
  if (!text || !text.trim()) throw new Error('Note is empty');
  let state = getState() || { demands: {} };
  if (!state.demands) state.demands = {};
  if (!state.demands[weekLabel]) state.demands[weekLabel] = {};
  if (!state.demands[weekLabel][day]) state.demands[weekLabel][day] = {};
  if (!state.demands[weekLabel][day].notes) state.demands[weekLabel][day].notes = [];
  const note = { text: text.trim(), email: user.email, ts: new Date().toISOString(), edited: false };
  state.demands[weekLabel][day].notes.unshift(note);
  state.demands[weekLabel][day].notes = state.demands[weekLabel][day].notes.slice(0, 20);
  state.lastModified = new Date().toISOString();
  const stateToSave = Object.assign({}, state);
  delete stateToSave.cptOverrides;
  PropertiesService.getScriptProperties().setProperty(STORAGE_KEY, JSON.stringify(stateToSave));
  writeAuditLog(user.email, 'note_add', 'notes', '', note.text, weekLabel, day);
  return { ok: true, note };
}

function editDayNote(weekLabel, day, idx, newText) {
  const user = getCurrentUser();
  if (!newText || !newText.trim()) throw new Error('Note is empty');
  let state = getState() || { demands: {} };
  const notes = state.demands?.[weekLabel]?.[day]?.notes;
  if (!notes || !notes[idx]) throw new Error('Note not found');
  const note = notes[idx];
  if (note.email.toLowerCase() !== user.email.toLowerCase()) throw new Error('Not authorized');
  const oldText = note.text;
  note.text = newText.trim();
  note.edited = true;
  state.lastModified = new Date().toISOString();
  const stateToSave = Object.assign({}, state);
  delete stateToSave.cptOverrides;
  PropertiesService.getScriptProperties().setProperty(STORAGE_KEY, JSON.stringify(stateToSave));
  writeAuditLog(user.email, 'note_edit', 'notes', oldText, note.text, weekLabel, day);
  return { ok: true };
}

function deleteDayNote(weekLabel, day, idx) {
  const user = getCurrentUser();
  let state = getState() || { demands: {} };
  const notes = state.demands?.[weekLabel]?.[day]?.notes;
  if (!notes || !notes[idx]) throw new Error('Note not found');
  const note = notes[idx];
  if (note.email.toLowerCase() !== user.email.toLowerCase() && !user.isAdmin) {
    throw new Error('Not authorized');
  }
  notes.splice(idx, 1);
  state.lastModified = new Date().toISOString();
  const stateToSave = Object.assign({}, state);
  delete stateToSave.cptOverrides;
  PropertiesService.getScriptProperties().setProperty(STORAGE_KEY, JSON.stringify(stateToSave));
  writeAuditLog(user.email, 'note_delete', 'notes', note.text, '', weekLabel, day);
  return { ok: true };
}

// ─── SLACK PUBLISH NOTIFY ─────────────────────────────────────────────────────

function sendPublishSlackNotify(weekLabel, days, mode) {
  const user = getCurrentUser();
  if (!user.isAdmin) throw new Error('Not authorized');
  throw new Error('Slack notify is temporarily disabled'); // DISABLED — remove this line to re-enable
  const webhookUrl = PropertiesService.getScriptProperties().getProperty('picktock_slack_webhook');
  if (!webhookUrl) throw new Error('Slack webhook not configured');
  const modeLabel = mode === 'actual' ? 'Actual Orders' : 'Forecast';
  const dayList = days.map(d => '• ' + d).join('\n');
  const appUrl = 'https://script.google.com/a/macros/farmersfridge.com/s/AKfycby58PFj1TWT_f0QhmDhX3YaZYfblruZ_yjcabpLfTdpBZvbM_5a-rhumyde53-b21to/exec';
  const text = [
    '*Pick Tock has been updated* \u23f1\ufe0f',
    '',
    '*Week:* ' + weekLabel,
    '*Mode:* ' + modeLabel,
    '*Days published:*',
    dayList,
    '',
    'Please review and approve your department for the days above. Raise any concerns in this thread. \ud83d\udd14',
    '',
    '<' + appUrl + '|Open Pick Tock \u2192>',
  ].join('\n');
  const payload = JSON.stringify({ text });
  const options = { method: 'post', contentType: 'application/json', payload };
  UrlFetchApp.fetch(webhookUrl, options);
  writeAuditLog(user.email, 'slack_notify', 'publish', '', weekLabel + ' (' + mode + ')', weekLabel, '');
  return { ok: true };
}
