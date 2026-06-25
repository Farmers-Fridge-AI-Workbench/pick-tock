// ─── DEMAND PLANNING SLACK REPORT ────────────────────────────────────────────

const SLACK_WEBHOOK_KEY = 'picktock_slack_webhook';

function setupDPReportTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sendDPReport')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('sendDPReport')
    .timeBased()
    .everyWeeks(1)
    .onWeekDay(ScriptApp.WeekDay.WEDNESDAY)
    .atHour(17) // 17:00 UTC = noon CDT
    .create();

  Logger.log('DP Report trigger set for Wednesdays at noon CDT');
}

function saveSlackWebhook(url) {
  PropertiesService.getScriptProperties().setProperty(SLACK_WEBHOOK_KEY, url);
  Logger.log('Webhook URL saved.');
}

function sendDPReport() {
  const webhookUrl = PropertiesService.getScriptProperties().getProperty(SLACK_WEBHOOK_KEY);
  if (!webhookUrl) { Logger.log('No webhook URL set'); return; }

  const state = getState();
  if (!state || !state.demands) { Logger.log('No state'); return; }

  const lhSchedule = state.lhSchedule || [];
  const cptOverrides = state.cptOverrides || {};
  const thruputs = state.thruputs || {};
  const MIDWEST = new Set(lhSchedule.filter(l => l.group === 'MW').map(l => l.lh));
  const DAYS_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const DAY_SHORT = {Monday:'Mon',Tuesday:'Tue',Wednesday:'Wed',Thursday:'Thu',Friday:'Fri',Saturday:'Sat',Sunday:'Sun'};

  // Figure out next week and prior week labels
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const currentWkNum = Math.ceil((((now - jan1) / 86400000) + jan1.getDay() + 1) / 7);
  const nextWkNum = currentWkNum + 1;
  const year = now.getFullYear();
  const nextWkLabel = 'W' + String(nextWkNum).padStart(2, '0') + '-' + year;
  const prevWkLabel = 'W' + String(currentWkNum).padStart(2, '00') + '-' + year;

  const nextWkData = state.demands[nextWkLabel];
  const prevWkData = state.demands[prevWkLabel];

  if (!nextWkData) { Logger.log('No data for ' + nextWkLabel); return; }

  function getLHScheduleForWeek(week) {
    if (!state.lhScheduleUpdates || !state.lhScheduleUpdates.length) return lhSchedule;
    const applicable = state.lhScheduleUpdates
      .filter(u => u.startWeek <= week)
      .sort((a, b) => b.startWeek.localeCompare(a.startWeek));
    return applicable.length ? applicable[0].schedule : lhSchedule;
  }

  function getCPT(lh, hov) {
    if (hov && hov.active && hov.cpts && hov.cpts[lh] !== undefined) return hov.cpts[lh];
    if (cptOverrides[lh] !== undefined) return cptOverrides[lh];
    const entry = lhSchedule.find(l => l.lh === lh);
    return entry ? entry.cpt : 23;
  }

  function getPreAllocLHs(weekData, day) {
    if (!weekData || !weekData[day]) return [];
    const dayData = weekData[day];
    const volByLH = dayData.vol || {};
    const levers = dayData.levers || {};
    const hov = dayData.holidayOverride;

    const DEFAULT_ALLOC_START = 18.25;
    const DEFAULT_PICK_START = 16.5;
    const DEFAULT_UPH = 2700;

    const mwStart = levers.allocStart !== undefined ? levers.allocStart : DEFAULT_ALLOC_START;
    const pickStart = levers.pickStart !== undefined ? levers.pickStart : DEFAULT_PICK_START;
    const uph = levers.uph !== undefined ? levers.uph : (thruputs[day] || DEFAULT_UPH);

    const weekSched = getLHScheduleForWeek(nextWkLabel);
    const dayShort = DAY_SHORT[day];

    // Get trucks that are scheduled that day, have volume, and are Non-MW
    const trucks = weekSched
      .filter(l => {
        if (MIDWEST.has(l.lh)) return false;
        if (!(volByLH[l.lh] > 0)) return false;
        if (hov && hov.active && hov.activeLHs) return hov.activeLHs.includes(l.lh);
        return l.days[dayShort];
      })
      .map(l => ({
        lh: l.lh,
        cpt: getCPT(l.lh, hov),
        vol: volByLH[l.lh]
      }))
      .sort((a, b) => a.cpt - b.cpt);

    if (!trucks.length) return [];

    // Simulate Phase 1 — run Non-MW trucks from pickStart up to mwStart
    const lines = (hov && hov.active && hov.lines) ? hov.lines :
      (() => {
        if (state.lineThreshold && state.lineThreshold.length) {
          const total = Object.values(volByLH).reduce((s, v) => s + v, 0);
          for (const t of state.lineThreshold.slice().sort((a, b) => b.vol - a.vol)) {
            if (total >= t.vol) return t.lines;
          }
        }
        return (state.lines && state.lines[day]) || 2;
      })();

    const lineFree = Array(lines).fill(pickStart);
    const truckTs = {};

    trucks.forEach(t => {
      const av = lineFree.reduce((s, f) => s + Math.max(0, mwStart - Math.max(f, pickStart)), 0);
      const vp = Math.min(t.vol, av * uph);
      if (vp > 0.1) {
        const hpl = (vp / lines) / uph;
        const si = Array.from({length: lines}, (_, i) => i)
          .sort((a, b) => Math.max(lineFree[a], pickStart) - Math.max(lineFree[b], pickStart));
        si.forEach(li => {
          const s = Math.max(lineFree[li], pickStart);
          if (truckTs[t.lh] === undefined) truckTs[t.lh] = s;
          lineFree[li] = s + hpl;
        });
      }
    });

    // Return Non-MW trucks whose start time is before mwStart, in CPT order
    return trucks
      .filter(t => truckTs[t.lh] !== undefined && truckTs[t.lh] < mwStart)
      .map(t => t.lh);
  }

  function shortLH(lh) {
    if (lh === 'S (DAL, HOU, AUS, SAT)') return 'S';
    if (lh === 'W (LA, SD)') return 'W';
    return lh;
  }

  // Build date labels for next week
  const dates = {};
  DAYS_ORDER.forEach(day => {
    const d = nextWkData[day];
    if (d && d.date) {
      const dt = new Date(d.date + 'T12:00:00');
      dates[day] = (dt.getMonth() + 1) + '/' + dt.getDate();
    } else {
      dates[day] = '';
    }
  });

  // Build rows
  const rows = DAYS_ORDER.map(day => {
    const nextLHs = getPreAllocLHs(nextWkData, day);
    const prevLHs = getPreAllocLHs(prevWkData, day);
    const nextStr = nextLHs.map(shortLH).join(' & ') || '—';
    const prevStr = prevLHs.map(shortLH).join(' & ') || '—';
    const changed = nextStr !== prevStr;
    return { day, date: dates[day], nextStr, prevStr, changed };
  });

  const dateRange = (() => {
    const first = rows.find(r => r.date);
    const last = [...rows].reverse().find(r => r.date);
    return first && last ? first.date + ' – ' + last.date : '';
  })();

  const tableRows = rows.map(r => {
    const dayLabel = DAY_SHORT[r.day] + (r.date ? ' ' + r.date : '');
    const vsCol = r.changed ? `⚠️ was ${r.prevStr}` : 'no change';
    return `${dayLabel.padEnd(10)}${r.nextStr.padEnd(14)}${vsCol}`;
  }).join('\n');

  const message = {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⏱️ *Pick Tock — Pre-allocation print order for ${nextWkLabel}${dateRange ? ' (' + dateRange + ')' : ''}*`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '```' + `${'Day'.padEnd(10)}${'Print first'.padEnd(14)}vs. last week\n${'-'.repeat(42)}\n${tableRows}` + '```'
        }
      }
    ]
  };

  const response = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(message),
    muteHttpExceptions: true
  });

  Logger.log('Slack response: ' + response.getResponseCode() + ' ' + response.getContentText());
}