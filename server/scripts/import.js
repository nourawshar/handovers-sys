'use strict';
/* Call-center data import from the Excel workbook into the dev handover system.
 * Reads TR1-TR4 employee rows and imports via the real HTTP API (login as admin,
 * POST /employees, /assets, /accounts, /assignments/phone, /assignments/generic).
 *
 * DRY_RUN=1 will only parse + print the mapped records, not write anything.
 * invoke from server/:  node scripts/import.js
 */
require('dotenv').config();
const ExcelJS = require('exceljs');
const fs = require('fs');

const DRY_RUN = process.env.DRY_RUN === '1';
const BASE = 'http://localhost:4000/api/v1';
const WB = '/opt/data/attachments/full deailed report for all the callcenter romm PCS and PHONES LASTTTTTTT UPDATED(AutoRecovered)(AutoRecovered).xlsx';

// Placeholder passwords: the source workbook provides NO credentials. The system requires a
// password field; we store an explicit placeholder and flag it in every account note.
const PLACEHOLDER_PW = 'please-set-from-source';

const TR_A = { emp: 1, real: 2, model: 3, imei: 4, storage: 5, wa1app: 6, wa1num: 7, wa1email: 8, wa1cond: 9, wa2app: 10, wa2num: 11, wa2email: 12, wa2cond: 13, phoneCond: 14, charger: 15, screen: 16, note: 17, rate: 18, pc: 20, monitor: 24, mouse: 25, keyboard: 26, headphone: 27, tr1: { os: 21, hdd: 22, ram: 23 }, tr4: { os: 22, hdd: 21, ram: 23 } };
const TR_B = { emp: 2, real: 3, model: 4, imei: 5, storage: 6, wa1app: 7, wa1num: 8, wa1email: 9, wa1cond: 10, wa2app: 11, wa2num: 12, wa2email: 13, wa2cond: 14, phoneCond: 15, charger: 16, screen: 17, note: 18, rate: 19, pc: 21, monitor: 25, mouse: 26, keyboard: 27, headphone: 28, tr2: { os: 22, hdd: 23, ram: 24 }, tr3: { os: 23, hdd: 22, ram: 24 } };
const SHEETS = { TR1: { cfg: TR_A, var: 'tr1' }, TR2: { cfg: TR_B, var: 'tr2' }, TR3: { cfg: TR_B, var: 'tr3' }, TR4: { cfg: TR_A, var: 'tr4' } };

// ── helpers ──
const cell = (row, n) => { if (!n) return ''; const v = row.getCell(n).value; if (v === null || v === undefined) return ''; if (typeof v === 'object') return (v.text ?? v.result ?? v.hyperlink ?? '').toString(); return String(v).trim(); };
const s = (v) => String(v ?? '').trim();
const digits = (v) => s(v).replace(/[^\d]/g, '');
// Take the LAST group of >=8 digits (handles "5111...1234 blocked, changed to 5594..." -> current number).
const normNum = (v) => { const g = s(v).match(/\d{8,}/g); return g && g.length ? g[g.length - 1] : null; };
const isPlaceholder = (v) => /with mr mahmoud/i.test(s(v));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const splitEmail = (t) => (EMAIL_RE.test(s(t)) ? s(t) : null);

function parseStorage(v) { const t = s(v); if (!t) return null; const m = t.replace(/\s/g, '').match(/(\d+(?:[.,]\d+)?)\/(\d+)/); return { raw: t, used: m ? parseFloat(m[1].replace(',', '.')) : null, total: m ? parseInt(m[2], 10) : null }; }

function mapApp(v) {
  const t = s(v).toLowerCase();
  if (!t) return null;
  if (/^n/i.test(t) || /normal|duplicat/i.test(t)) return 'NORMAL';
  if (/^b/i.test(t) || /bus|bues/i.test(t)) return 'BUSINESS';
  return null;
}

function mapCondition(v) {
  const t = s(v).toLowerCase();
  if (!t) return { cond: null, raw: s(v) };
  let cond = 'GOOD';
  if (/(broken|damag|crack|scratch|scran|scra?ched|need change|need replac|screnn is broken)/.test(t)) cond = 'DAMAGED';
  else if (/(bad|poor|slow|not good|not working)/.test(t)) cond = 'POOR';
  else if (/(fair|dirt|usable)/.test(t)) cond = 'FAIR';
  return { cond, raw: s(v) };
}

function parseBackup(v) {
  const t = s(v);
  const empty = !t || /^no\s*backup/i.test(t) || /is blocked/i.test(t);
  let date = null;
  const dm = t.match(/(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})/);
  if (dm) { let y = dm[3]; if (y.length === 2) y = '20' + y; date = `${y}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`; }
  else { const im = t.match(/(\d{4})-(\d{2})-(\d{2})/); if (im) date = im[0].slice(0, 10); }
  let usedGB = null, totalGB = null;
  const clean = t.replace(/\u00a0/g, ' ');
  const gm = clean.match(/(\d+(?:[.,]\d+)?)\s*gb\s*\/\s*(\d+(?:[.,]\d+)?)/i);
  const fm = clean.match(/(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*gb/i);
  if (gm) { usedGB = parseFloat(gm[1].replace(',', '.')); totalGB = parseFloat(gm[2].replace(',', '.')); }
  else if (fm) { usedGB = parseFloat(fm[1].replace(',', '.')); totalGB = parseFloat(fm[2].replace(',', '.')); }
  return { raw: t, empty, hasData: !!t, date, usedGB, totalGB };
}

function brandModel(raw) {
  const t = s(raw);
  const low = t.toLowerCase();
  const isXiaomi = /redmi|xiaomi|poco/.test(low);
  const isSamsung = /samsung|galaxy|^a\d|^s\d|note 9/.test(low);
  if (isXiaomi) {
    let m = t.replace(/^(xiaomi|redmi|poco)\s+/i, '').replace(/\s+/g, ' ').trim();
    const x = { 'note 9': 'Redmi Note 9', 'note 9 pro': 'Redmi Note 9 Pro', 'note 11': 'Redmi Note 11', '9t': 'Redmi 9T', '9': 'Redmi 9' };
    const mm = x[m.toLowerCase()] || m || 'Phone';
    return { make: 'Xiaomi', model: mm, name: `Xiaomi ${mm}` };
  }
  if (isSamsung) {
    let m = t.replace(/^(samsung|galaxy)\s+/i, '').replace(/\s+/g, ' ').trim();
    const k = { a12: 'A12', a13: 'A13', a02s: 'A02S', a02: 'A02S', a21s: 'A21s', a22: 'A22', 'a25 5g': 'A25 5G', a25: 'A25 5G', 'a26 5g': 'A26 5G', a26: 'A26 5G', 'note 9': 'Note 9' };
    const mm = k[m.toLowerCase()] || (m || 'Phone');
    const disp = /^galaxy/i.test(mm) ? mm : `Galaxy ${mm}`;
    return { make: 'Samsung', model: mm, name: `Samsung ${disp}` };
  }
  return { make: '', model: t || 'Phone', name: t || 'Phone' };
}

function parseRow(sheetName, row, rn) {
  const { cfg, var: v } = SHEETS[sheetName];
  const g = (n) => cell(row, n);
  const empName = s(g(cfg.emp));
  if (!empName) return null;
  const realRaw = g(cfg.real);
  if (isPlaceholder(empName) || (realRaw && isPlaceholder(realRaw))) return { sheet: sheetName, row: rn, empName, skip: true, reason: 'placeholder row (no real device data)' };

  const osCol = cfg[v]?.os, hddCol = cfg[v]?.hdd, ramCol = cfg[v]?.ram;
  const model = s(g(cfg.model));
  const imei = digits(g(cfg.imei));
  const hasPhone = !!model || imei.length >= 14;
  const pcVal = s(g(cfg.pc));
  const hasPc = !!pcVal && !/^secondary$/i.test(pcVal) && !/no pc/i.test(pcVal) && !/secondaryphone/i.test(pcVal);

  if (!hasPhone && !hasPc) return { sheet: sheetName, row: rn, empName, skip: true, reason: 'no phone or PC data' };

  const chargerRaw = s(g(cfg.charger));
  const screenRaw = s(g(cfg.screen));
  const waNumMemos = [];
  for (const [label, raw] of [['Main WhatsApp no', g(cfg.wa1num)], ['Sec WhatsApp no', g(cfg.wa2num)]]) {
    if (/[a-z]/i.test(raw) && !/^no\b/i.test(raw)) waNumMemos.push(`${label}: ${raw}`);
  }
  const noteAll = [s(g(cfg.note)), screenRaw ? `Screen protector: ${screenRaw}` : '', chargerRaw ? `Charger: ${chargerRaw}` : '', ...waNumMemos].filter(Boolean).join(' | ');
  const acc = ['monitor', 'mouse', 'keyboard', 'headphone'].map((k) => ({ key: k, val: s(g(cfg[k])) }));

  return {
    sheet: sheetName, row: rn, empName, real: realRaw || empName,
    model, imei: imei.length >= 14 ? imei : null, imeiRaw: s(g(cfg.imei)), imeiInvalid: hasPhone && imei.length >= 1 && imei.length < 14,
    storage: parseStorage(g(cfg.storage)), hasPhone, hasPc,
    wa1app: mapApp(g(cfg.wa1app)), wa1num: normNum(g(cfg.wa1num)), wa1numRaw: s(g(cfg.wa1num)), wa1email: s(g(cfg.wa1email)), wa1cond: parseBackup(g(cfg.wa1cond)),
    wa2app: mapApp(g(cfg.wa2app)), wa2num: normNum(g(cfg.wa2num)), wa2numRaw: s(g(cfg.wa2num)), wa2email: s(g(cfg.wa2email)), wa2cond: parseBackup(g(cfg.wa2cond)),
    phoneCond: mapCondition(g(cfg.phoneCond)),
    pc: pcVal, pcOs: s(g(osCol)), pcHdd: s(g(hddCol)), pcRam: s(g(ramCol)),
    accessories: acc.map((a) => { const c = mapCondition(a.val); return { key: a.key, cond: c.cond, raw: a.val }; }),
    note: noteAll,
  };
}

// ── API client ──
let token = null;
async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch { j = null; }
  return { status: res.status, body: j };
}
async function login() { const r = await api('POST', '/auth/login', { username: 'admin', password: process.env.SEED_ADMIN_PASSWORD }); if (r.status !== 200) throw new Error('login failed: ' + JSON.stringify(r.body)); token = r.body.accessToken; return r.body.user; }

const OK = (r, what) => { if (r.status >= 200 && r.status < 300) return true; console.error(`    ! ${what} HTTP ${r.status}: ${JSON.stringify(r.body?.error ?? r.body)?.slice(0, 300)}`); return false; };

// ── main ──
async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WB);
  const records = [];
  for (const sh of ['TR1', 'TR2', 'TR3', 'TR4']) { const ws = wb.getWorksheet(sh); ws.eachRow((row, rn) => { if (rn === 1) return; const rec = parseRow(sh, row, rn); if (rec) records.push(rec); }); }
  const imports = records.filter((r) => !r.skip);
  const skipped = records.filter((r) => r.skip);

  if (DRY_RUN) {
    console.log('===== PARSED RECORDS (DRY-RUN) =====');
    console.log('Total rows:', records.length, '| importable:', imports.length, '| skipped:', skipped.length);
    for (const r of skipped) console.log(`  [SKIP] ${r.sheet} R${r.row} ${r.empName}: ${r.reason}`);
    for (const sh of ['TR1', 'TR2', 'TR3', 'TR4']) {
      const recs = records.filter((r) => r.sheet === sh && !r.skip);
      console.log(`\n--- ${sh}: ${recs.length} ---`);
      for (const r of recs) {
        const phone = r.hasPhone ? `${brandModel(r.model || 'A12').name}/${r.imei || 'NO-IMEI'}` : '—';
        const pc = r.hasPc ? `${r.pc} ${r.pcOs} ${r.pcHdd} ${r.pcRam}` : '—';
        console.log(`R${r.row} ${r.empName} | real="${r.real}" | phone=[${phone}] ${r.phoneCond.cond} | wa1=${r.wa1num}${r.wa1app || ''}|${r.wa1email} | ${r.wa2num ? ('wa2=' + r.wa2num + '|' + r.wa2email) : ''} | pc=[${pc}]`);
      }
    }
    fs.writeFileSync('/tmp/parsed_records.json', JSON.stringify(records, null, 2));
    console.log('\nDRY_RUN=1 — no changes written. Preview saved to /tmp/parsed_records.json');
    process.exit(0);
  }

  // ── REAL IMPORT ──
  await login();
  console.log('Logged in as admin.');

  const depts = (await api('GET', '/departments')).body.data;
  const cc = depts.find((d) => d.name === 'Call Center');
  const rooms = (await api('GET', '/rooms')).body.data;
  const roomByCode = Object.fromEntries(rooms.map((r) => [r.code, r]));
  const cats = (await api('GET', '/asset-categories')).body.data;
  const catByName = {};
  for (const c of cats) catByName[c.name] = c;

  const ensureCat = async (name, codePrefix) => {
    if (catByName[name]) return catByName[name];
    const r = await api('POST', '/asset-categories', { name, kind: 'physical', codePrefix });
    if (!OK(r, `create category ${name}`)) throw new Error(`cannot create category ${name}`);
    const c = r.body.data; catByName[c.name] = c; return c;
  };
  const computers = await ensureCat('Computers', 'COM');
  await ensureCat('Monitors', 'MON');
  await ensureCat('Mouse', 'MOU');
  await ensureCat('Keyboards', 'KBD');
  await ensureCat('Headphones', 'HPH');
  const phonesCat = catByName['Phones'];
  console.log('Categories ready: Phones=%s Computers=%s', phonesCat?.name, computers.name);

  const accountCache = new Map();
  const employeeCache = new Map();

  async function findEmployee(full, deptId) {
    const key = `${full}::${deptId}`;
    if (employeeCache.has(key)) return employeeCache.get(key);
    const r = await api('GET', `/employees?departmentTeamId=${deptId}&q=${encodeURIComponent(full)}&limit=200`);
    const rows = r.body?.data || [];
    const hit = rows.find((e) => e.fullName === full);
    if (hit) { employeeCache.set(key, hit.id); return hit.id; }
    return null;
  }
  async function createEmployee(full, deptId, roomId) {
    const existing = await findEmployee(full, deptId);
    if (existing) return existing;
    const r = await api('POST', '/employees', { fullName: full, departmentTeamId: deptId, roomId });
    if (r.status >= 200 && r.status < 300) { employeeCache.set(`${full}::${deptId}`, r.body.data.id); return r.body.data.id; }
    if (r.status === 409) { const e = await findEmployee(full, deptId); if (e) return e; }
    throw new Error(`employee create failed ${full}: ${JSON.stringify(r.body)}`);
  }
  async function getAccount(kind, identifier, subcategory, email) {
    if (accountCache.has(identifier)) return accountCache.get(identifier);
    const r = await api('POST', '/accounts', { kind, identifier, subcategory, email, isWhatsAppBackup: kind === 'GMAIL', isActive: true, password: PLACEHOLDER_PW, notes: 'Imported from call-center report. Credentials not provided in the source workbook (password is a placeholder).' });
    if (r.status < 300) { accountCache.set(identifier, r.body.data.id); return r.body.data.id; }
    if (r.status === 409) {
      const q = await api('GET', `/accounts?identifier=${encodeURIComponent(identifier)}&limit=5`);
      const hit = q.body?.data?.find((a) => a.identifier === identifier);
      if (hit) { accountCache.set(identifier, hit.id); return hit.id; }
    }
    throw new Error(`account create failed ${identifier}: ${JSON.stringify(r.body).slice(0, 200)}`);
  }

  const summary = { employees: 0, phones: 0, pcs: 0, accessories: 0, gmailAccounts: 0, whatsappAccounts: 0, phoneAssignments: 0, genericAssignments: 0 };
  const issues = [];
  const report = [];

  for (const sh of ['TR1', 'TR2', 'TR3', 'TR4']) {
    const room = roomByCode[sh];
    const recs = records.filter((r) => r.sheet === sh && !r.skip);
    console.log(`\n===== Importing ${sh} (${recs.length} employees) =====`);
    for (const r of recs) {
      const log = { sheet: r.sheet, row: r.row, emp: r.empName, real: r.real, phone: null, pc: null, accounts: [], assignment: null, note: r.note };
      try {
        const empId = await createEmployee(r.real, cc.id, room.id);
        summary.employees++;
        log.employeeId = empId;

        let phoneAssetId = null;
        if (r.hasPhone) {
          if (r.imei) {
            const bm = brandModel(r.model || 'A12');
            const cond = r.phoneCond.cond || 'GOOD';
            const resp = await api('POST', '/assets', { categoryId: phonesCat.id, name: bm.name, condition: cond, status: 'AVAILABLE', roomId: room.id, notes: r.note ? `Note: ${r.note}` : null, phone: { imei: r.imei, model: bm.model, make: bm.make || undefined, storage: r.storage ? r.storage.raw : undefined, ...(r.wa1app ? { appBinary: r.wa1app } : {}) } });
            if (OK(resp, `phone asset ${r.imei}`)) { phoneAssetId = resp.body.data.id; summary.phones++; log.phone = r.imei; }
            else if (resp.status === 409) { log.phone = `${r.imei} (conflict/dup)`; }
          } else {
            issues.push(`${sh} R${r.row} ${r.empName}: phone model "${r.model}" but NO/INVALID IMEI (raw "${r.imeiRaw}") — phone asset + phone assignment skipped`);
            log.warn = 'no-valid-imei';
          }
        }

        // 3. Gmail backup accounts
        const emails = [r.wa1email, r.wa2email].map(splitEmail).filter(Boolean);
        const uniqEmails = [...new Set(emails)];
        for (const em of uniqEmails) {
          try {
            const id = await getAccount('GMAIL', em, 'GMail for WhatsApp backup', em);
            if (id) { summary.gmailAccounts++; log.accounts.push('gmail:' + em); }
          } catch (e) { issues.push(`${sh} R${r.row} ${r.empName}: gmail account skipped (${em}): ${e.message?.slice(0, 120)}`); }
        }
        let wa2Email = splitEmail(r.wa2email);
        if (!wa2Email && /same|main|booth|both/i.test(r.wa2email) && splitEmail(r.wa1email)) wa2Email = splitEmail(r.wa1email);

        // 4. WhatsApp/SIM numbers as accounts
        const nums = [...new Set([r.wa1num, r.wa2num].filter(Boolean))];
        for (const num of nums) {
          try {
            const isBiz = (num === r.wa1num && r.wa1app === 'BUSINESS') || (num === r.wa2num && r.wa2app === 'BUSINESS');
            await getAccount('WHATSAPP', num, isBiz ? 'WhatsApp Business' : 'WhatsApp', null);
            summary.whatsappAccounts++; log.accounts.push('wa:' + num);
          } catch (e) { issues.push(`${sh} R${r.row} ${r.empName}: whatsapp account skipped (${num}): ${e.message?.slice(0, 120)}`); }
        }

        // 5. PC + accessories assets
        let pcAssetId = null;
        if (r.hasPc) {
          const pcNotes = [`OS: ${r.pcOs || '?'}`, `HDD: ${r.pcHdd || '?'}`, `RAM: ${r.pcRam || '?'}`].filter((x) => x).join(' | ');
          const pcResp = await api('POST', '/assets', { categoryId: computers.id, name: r.pc, condition: 'GOOD', status: 'AVAILABLE', roomId: room.id, notes: pcNotes });
          if (OK(pcResp, `PC ${r.pc}`)) { pcAssetId = pcResp.body.data.id; summary.pcs++; log.pc = r.pc; }
          for (const a of r.accessories) {
            if (!a.raw || /^secondary$/i.test(a.raw) || /^no headphone/i.test(a.raw) || /^no\b/i.test(a.raw)) continue;
            const cat = { monitor: catByName['Monitors'], mouse: catByName['Mouse'], keyboard: catByName['Keyboards'], headphone: catByName['Headphones'] }[a.key];
            const cap = { monitor: 'Monitor', mouse: 'Mouse', keyboard: 'Keyboard', headphone: 'Headphone' }[a.key];
            const ar = await api('POST', '/assets', { categoryId: cat.id, name: cap, condition: a.cond || 'GOOD', status: 'AVAILABLE', roomId: room.id, notes: a.raw ? `Condition: ${a.raw}` : null });
            if (ar.status < 300) { summary.accessories++; log.accounts.push('acc:' + a.key); }
          }
        }

        // 6. Assignment
        const wid = { name: r.empName, departmentTeamId: cc.id, roomId: room.id };
        if (phoneAssetId) {
          const wa1Email = splitEmail(r.wa1email);
          const body = {
            employeeId: empId, workIdentity: wid, phoneAssetId,
            sim1Number: r.wa1num || undefined, wa1Business: r.wa1app === 'BUSINESS', wa1PhoneNumber: r.wa1num || undefined,
            wa1BackupEmail: wa1Email || undefined, wa1AppVariant: r.wa1app || undefined,
            ...(r.wa1cond.date ? { wa1BackupDate: r.wa1cond.date } : {}),
            ...(r.wa1cond.usedGB != null ? { wa1BackupUsedGB: r.wa1cond.usedGB } : {}),
            ...(r.wa1cond.totalGB != null ? { wa1BackupTotalGB: r.wa1cond.totalGB } : {}),
            sim2Number: r.wa2num || undefined, wa2Business: r.wa2app === 'BUSINESS', wa2PhoneNumber: r.wa2num || undefined,
            wa2BackupEmail: wa2Email || undefined, wa2AppVariant: r.wa2app || undefined,
            ...(r.wa2cond.date ? { wa2BackupDate: r.wa2cond.date } : {}),
            ...(r.wa2cond.usedGB != null ? { wa2BackupUsedGB: r.wa2cond.usedGB } : {}),
            ...(r.wa2cond.totalGB != null ? { wa2BackupTotalGB: r.wa2cond.totalGB } : {}),
            notes: r.note ? `Note: ${r.note}` : undefined,
          };
          const ar = await api('POST', '/assignments/phone', body);
          if (OK(ar, `phone assignment ${r.empName}`)) { summary.phoneAssignments++; log.assignment = 'PHONE'; }
          else { issues.push(`${sh} R${r.row} ${r.empName}: phone assignment failed: ${JSON.stringify(ar.body?.error)?.slice(0, 200)}`); log.assignment = 'PHONE-FAIL'; }
        } else if (pcAssetId) {
          const ar = await api('POST', '/assignments/generic', { type: 'LAPTOP', employeeId: empId, workIdentity: wid, assetId: pcAssetId, conditionAtHandover: 'GOOD', notes: r.note ? `Note: ${r.note}` : undefined });
          if (OK(ar, `generic assignment ${r.empName}`)) { summary.genericAssignments++; log.assignment = 'GENERIC'; }
          else issues.push(`${sh} R${r.row} ${r.empName}: generic assignment failed: ${JSON.stringify(ar.body?.error)?.slice(0, 200)}`);
        } else {
          issues.push(`${sh} R${r.row} ${r.empName}: no phone asset (missing/dup IMEI) and no PC — no assignment created`);
        }
      } catch (e) {
        issues.push(`${sh} R${r.row} ${r.empName}: EXCEPTION ${e.message?.slice(0, 200)}`);
        log.error = e.message?.slice(0, 200);
      }
      report.push(log);
    }
  }

  fs.writeFileSync('/tmp/import_report.json', JSON.stringify({ summary, issues, report }, null, 2));
  console.log('\n===== IMPORT SUMMARY =====');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nIssues (%d):', issues.length);
  for (const i of issues) console.log('  -', i);
  console.log('\nReport saved to /tmp/import_report.json');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });