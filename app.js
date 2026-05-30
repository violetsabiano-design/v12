const STORAGE_KEY     = "geobonn-expenditure-v2";
const AUDIT_KEY       = "geobonn-audit-log-v1";
const SYSTEM_NAME     = "GEOBONN EXPENDITURE";
const MONTH_NAMES = [
  "JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE",
  "JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER",
];
const MONTH_ALIASES = {
  JAN:"JANUARY",FEB:"FEBRUARY",MAR:"MARCH",APR:"APRIL",MAY:"MAY",
  JUN:"JUNE",JUL:"JULY",AUG:"AUGUST",SEP:"SEPTEMBER",SEPT:"SEPTEMBER",
  OCT:"OCTOBER",NOV:"NOVEMBER",DEC:"DECEMBER",
};

const state = {
  data: { monthData: [] },
  selectedYear: "",
  selectedMonth: "",
  query: "",
  hideAmounts: false,
};

/* ── audit trail ─────────────────────────────────────────────────────── */
// Each entry: { id, ts, type, desc, snapshot }
// snapshot = JSON string of state.data before the change
let auditLog = [];
const MAX_AUDIT = 200;

function loadAudit() {
  try { auditLog = JSON.parse(localStorage.getItem(AUDIT_KEY) || "[]"); }
  catch { auditLog = []; }
}
function saveAudit() {
  if (auditLog.length > MAX_AUDIT) auditLog = auditLog.slice(0, MAX_AUDIT);
  localStorage.setItem(AUDIT_KEY, JSON.stringify(auditLog));
}
function pushAudit(type, desc) {
  const snapshot = JSON.stringify(state.data);
  auditLog.unshift({
    id: makeId(),
    ts: new Date().toISOString(),
    type, // "add" | "edit" | "delete" | "payment"
    desc,
    snapshot,
  });
  saveAudit();
  renderAuditLog();
}
function undoAudit(entryId) {
  const idx = auditLog.findIndex(e => e.id === entryId);
  if (idx < 0) return;
  const entry = auditLog[idx];
  // Restore data from snapshot stored BEFORE that change
  state.data = normalizeData(JSON.parse(entry.snapshot));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
  queueCloudSave();
  // Remove this and all newer entries
  auditLog = auditLog.slice(idx + 1);
  saveAudit();
  if (!selectedYearMonths().some(m => m.month === state.selectedMonth)) setInitialPeriod();
  render();
}

/* ── cloud ───────────────────────────────────────────────────────────── */
const cloud = {
  configured:false, enabled:false, user:null, db:null, auth:null,
  docRef:null, unsubscribe:null, setDoc:null, onSnapshot:null,
  serverTimestamp:null, applyingRemote:false, saveTimer:null,
};

/* ── DOM refs ────────────────────────────────────────────────────────── */
const els = {
  yearSelect:        document.querySelector("#yearSelect"),
  monthSelect:       document.querySelector("#monthSelect"),
  newMonthInput:     document.querySelector("#newMonthInput"),
  addMonthBtn:       document.querySelector("#addMonthBtn"),
  resetBtn:          document.querySelector("#resetBtn"),
  plannedTotal:      document.querySelector("#plannedTotal"),
  paidTotal:         document.querySelector("#paidTotal"),
  balanceTotal:      document.querySelector("#balanceTotal"),
  completionRate:    document.querySelector("#completionRate"),
  entryForm:         document.querySelector("#entryForm"),
  entryId:           document.querySelector("#entryId"),
  itemInput:         document.querySelector("#itemInput"),
  plannedInput:      document.querySelector("#plannedInput"),
  paidInput:         document.querySelector("#paidInput"),
  statusInput:       document.querySelector("#statusInput"),
  formTitle:         document.querySelector("#formTitle"),
  clearFormBtn:      document.querySelector("#clearFormBtn"),
  saveItemBtn:       document.querySelector("#saveItemBtn"),
  searchInput:       document.querySelector("#searchInput"),
  itemsBody:         document.querySelector("#itemsBody"),
  trendChart:        document.querySelector("#trendChart"),
  paymentForm:       document.querySelector("#paymentForm"),
  paymentItemSelect: document.querySelector("#paymentItemSelect"),
  paymentDateInput:  document.querySelector("#paymentDateInput"),
  paymentAmountInput:document.querySelector("#paymentAmountInput"),
  recordPaymentBtn:  document.querySelector("#recordPaymentBtn"),
  paymentLog:        document.querySelector("#paymentLog"),
  exportCsvBtn:      document.querySelector("#exportCsvBtn"),
  monthlyPdfBtn:     document.querySelector("#monthlyPdfBtn"),
  expensePdfBtn:     document.querySelector("#expensePdfBtn"),
  hideAmountsInput:  document.querySelector("#hideAmountsInput"),
  syncStatus:        document.querySelector("#syncStatus"),
  syncHelp:          document.querySelector("#syncHelp"),
  openAuthBtn:       document.querySelector("#openAuthBtn"),
  closeAuthBtn:      document.querySelector("#closeAuthBtn"),
  authModal:         document.querySelector("#authModal"),
  authForm:          document.querySelector("#authForm"),
  emailInput:        document.querySelector("#emailInput"),
  passwordInput:     document.querySelector("#passwordInput"),
  signInBtn:         document.querySelector("#signInBtn"),
  signUpBtn:         document.querySelector("#signUpBtn"),
  signOutBtn:        document.querySelector("#signOutBtn"),
  userBadge:         document.querySelector("#userBadge"),
  userBadgeEmail:    document.querySelector("#userBadgeEmail"),
  yearlyTitle:       document.querySelector("#yearlyTitle"),
  yearlyTotal:       document.querySelector("#yearlyTotal"),
  yearlyMonthBars:   document.querySelector("#yearlyMonthBars"),
  yearComparisonBody:document.querySelector("#yearComparisonBody"),
  emptyStateTemplate:document.querySelector("#emptyStateTemplate"),
  authLockBanner:    document.querySelector("#authLockBanner"),
  auditLog:          document.querySelector("#auditLog"),
  clearAuditBtn:     document.querySelector("#clearAuditBtn"),
};

const money = new Intl.NumberFormat("en-KE",{style:"currency",currency:"KES",maximumFractionDigits:0});

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

/* ── Auth-gating helpers ─────────────────────────────────────────────── */
function isLoggedIn() {
  return Boolean(cloud.configured && cloud.user);
}

function updateEditLock() {
  const locked = !isLoggedIn();
  // Show/hide lock banner on the entry form
  els.authLockBanner.hidden = !locked;
  // Disable entry form fields + submit
  const formFields = [els.itemInput, els.plannedInput, els.paidInput, els.statusInput, els.saveItemBtn];
  for (const el of formFields) {
    el.disabled = locked;
  }
  // Disable payment recording
  els.paymentAmountInput.disabled = locked;
  els.paymentItemSelect.disabled  = locked;
  els.paymentDateInput.disabled   = locked;
  els.recordPaymentBtn.disabled   = locked;
  // Re-render items so Edit/Delete buttons reflect lock state
  renderItems();
}

/* ── Data helpers ────────────────────────────────────────────────────── */
function normalizeRow(row) {
  const planned = Number(row.planned || 0);
  const paid    = Number(row.paid    || 0);
  return {
    id:         row.id || makeId(),
    item:       String(row.item || "").trim(),
    planned,
    paid,
    balance:    planned - paid,
    percentage: planned ? paid / planned : 0,
    status:     row.status || inferStatus(planned, paid),
    daily:      Array.isArray(row.daily) ? row.daily : [],
  };
}

function inferStatus(planned, paid) {
  if (planned > 0 && paid > planned)  return "OVERPAID";
  if (planned > 0 && paid >= planned) return "CLEARED";
  if (paid > 0)                       return "PARTIAL";
  return "PENDING";
}

function currentMonth() {
  return state.data.monthData.find(m => m.month === state.selectedMonth);
}
function selectedYearMonths() {
  return state.data.monthData.filter(m => monthYear(m.month) === state.selectedYear);
}

function normalizeData(data) {
  data.monthData = (data.monthData || []).map(month => ({
    ...month,
    month: normalizeMonthName(month.month),
    rows:  (month.rows || []).map(normalizeRow),
  }));
  data.monthData.sort((a, b) => monthSortValue(a.month) - monthSortValue(b.month));
  return data;
}

function normalizeMonthName(value) {
  const raw   = String(value || "").trim().toUpperCase().replace(/\s+BUDGET$/, "");
  const parts = raw.split(/\s+/);
  const month = MONTH_ALIASES[parts[0]] || parts[0];
  const yearPart = parts.find(p => /^\d{2,4}$/.test(p));
  let year = 2024;
  if (yearPart) {
    const n = Number(yearPart);
    year = yearPart.length === 2 ? 2000 + n : n;
  }
  return MONTH_NAMES.includes(month) ? `${month} ${year}` : raw;
}

function monthSortValue(label) {
  const [month, year] = String(label).split(/\s+/);
  return Number(year || 0) * 12 + MONTH_NAMES.indexOf(month);
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
  queueCloudSave();
}

async function loadInitialData(forceSeed = false) {
  if (!forceSeed) {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      state.data = normalizeData(JSON.parse(stored));
      setInitialPeriod();
      return;
    }
  }
  const response = await fetch("budget-seed.json", { cache: "no-store" });
  const seed = await response.json();
  state.data = normalizeData(seed);
  setInitialPeriod();
  save();
}

/* ── Render ──────────────────────────────────────────────────────────── */
function render() {
  els.hideAmountsInput.checked = state.hideAmounts;
  renderSyncStatus();
  renderYearSelect();
  renderMonthSelect();
  renderSummary();
  renderYearlySummary();
  renderItems();
  renderTrend();
  renderPaymentTools();
  renderAuditLog();
  updateEditLock();
}

function renderSyncStatus(message) {
  if (!cloud.configured) {
    els.syncStatus.textContent  = "Local mode";
    els.syncHelp.textContent    = "Add your Firebase web config to firebase-config.js to make this system live.";
    els.openAuthBtn.disabled    = true;
    els.signOutBtn.hidden       = true;
    els.userBadge.hidden        = true;
    return;
  }
  if (!cloud.user) {
    els.syncStatus.textContent  = message || "Live ready";
    els.syncHelp.textContent    = "Open Account and sign in to keep this system live across your devices.";
    els.openAuthBtn.disabled    = false;
    els.signInBtn.disabled      = false;
    els.signUpBtn.disabled      = false;
    els.signOutBtn.hidden       = true;
    els.userBadge.hidden        = true;
    return;
  }
  els.syncStatus.textContent    = message || "Live";
  els.syncHelp.textContent      = "Changes are live across signed-in devices.";
  els.openAuthBtn.disabled      = false;
  els.signInBtn.disabled        = true;
  els.signUpBtn.disabled        = true;
  els.signOutBtn.hidden         = false;
  els.userBadge.hidden          = false;
  els.userBadgeEmail.textContent = cloud.user.email || "Signed in";
}

function setInitialPeriod() {
  const first = state.data.monthData[0]?.month || "";
  state.selectedMonth = first;
  state.selectedYear  = first ? monthYear(first) : "";
}

function renderYearSelect() {
  const years = getYears();
  if (!years.includes(state.selectedYear)) state.selectedYear = years[0] || "";
  els.yearSelect.innerHTML = "";
  for (const year of years) {
    const opt = document.createElement("option");
    opt.value = year; opt.textContent = year;
    opt.selected = year === state.selectedYear;
    els.yearSelect.append(opt);
  }
}

function renderMonthSelect() {
  els.monthSelect.innerHTML = "";
  const months = selectedYearMonths();
  if (!months.some(m => m.month === state.selectedMonth))
    state.selectedMonth = months[0]?.month || "";
  for (const month of months) {
    const opt = document.createElement("option");
    opt.value = month.month;
    opt.textContent = monthNameOnly(month.month);
    opt.selected = month.month === state.selectedMonth;
    els.monthSelect.append(opt);
  }
}

function renderSummary() {
  const month   = currentMonth();
  const rows    = month?.rows || [];
  const planned = sum(rows, "planned");
  const paid    = sum(rows, "paid");
  const balance = planned - paid;
  const pct     = planned ? Math.round((paid / planned) * 100) : 0;
  els.plannedTotal.textContent  = formatHomeMoney(planned);
  els.paidTotal.textContent     = formatHomeMoney(paid);
  els.balanceTotal.textContent  = formatHomeMoney(balance);
  els.completionRate.textContent = `${pct}%`;
  els.balanceTotal.style.color  = balance < 0 ? "var(--danger)" : "var(--ink)";
}

function renderItems() {
  const month  = currentMonth();
  const locked = !isLoggedIn();
  const rows   = (month?.rows || []).filter(r =>
    r.item.toLowerCase().includes(state.query.toLowerCase()),
  );
  els.itemsBody.innerHTML = "";
  if (!rows.length) {
    els.itemsBody.append(els.emptyStateTemplate.content.cloneNode(true));
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    const progress = Math.max(0, Math.min(100, Math.round(row.percentage * 100)));
    const status   = inferStatus(row.planned, row.paid);
    tr.innerHTML = `
      <td><strong>${escapeHtml(row.item)}</strong></td>
      <td class="number">${formatHomeMoney(row.planned)}</td>
      <td class="number">${formatHomeMoney(row.paid)}</td>
      <td class="number">${formatHomeMoney(row.planned - row.paid)}</td>
      <td>
        <div class="progress-track" title="${progress}% paid">
          <div class="progress-fill" style="width:${progress}%"></div>
        </div>
      </td>
      <td><span class="status ${status.toLowerCase()}">${status}</span></td>
      <td>
        <div class="row-actions">
          <button type="button" data-action="edit"   data-id="${row.id}" ${locked ? "disabled title='Sign in to edit'"   : ""}>Edit</button>
          <button class="delete" type="button" data-action="delete" data-id="${row.id}" ${locked ? "disabled title='Sign in to delete'" : ""}>Delete</button>
        </div>
      </td>
    `;
    els.itemsBody.append(tr);
  }
}

function renderTrend() {
  const totals = selectedYearMonths().map(m => ({
    month:   m.month,
    planned: sum(m.rows, "planned"),
    paid:    sum(m.rows, "paid"),
  }));
  const maxPaid = Math.max(1, ...totals.map(m => m.paid));
  els.trendChart.innerHTML = "";
  for (const item of totals) {
    const width = Math.max(3, Math.round((item.paid / maxPaid) * 100));
    const row   = document.createElement("div");
    row.className = "trend-row";
    row.innerHTML = `
      <div class="trend-label">${escapeHtml(monthNameOnly(item.month))}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
      <div class="trend-value">${formatHomeMoney(item.paid)}</div>
    `;
    els.trendChart.append(row);
  }
}

function renderYearlySummary() {
  const months  = selectedYearMonths();
  const yearPaid = months.reduce((t, m) => t + sum(m.rows, "paid"), 0);
  els.yearlyTitle.textContent = `${state.selectedYear || "Year"} summary`;
  els.yearlyTotal.textContent = formatHomeMoney(yearPaid);
  const maxPaid = Math.max(1, ...months.map(m => sum(m.rows, "paid")));
  els.yearlyMonthBars.innerHTML = months.length
    ? months.map(m => {
        const paid  = sum(m.rows, "paid");
        const width = Math.max(4, Math.round((paid / maxPaid) * 100));
        return `
          <div class="year-bar-row">
            <span>${escapeHtml(monthNameOnly(m.month))}</span>
            <div class="year-bar-track"><div class="year-bar-fill" style="width:${width}%"></div></div>
            <strong>${formatHomeMoney(paid)}</strong>
          </div>
        `;
      }).join("")
    : `<p class="empty-state">No months found for this year.</p>`;

  const summaries = getYearSummaries();
  els.yearComparisonBody.innerHTML = summaries.map((s, i) => {
    const prev     = summaries[i - 1];
    const variance = prev ? s.paid - prev.paid : 0;
    return `
      <tr class="${s.year === state.selectedYear ? "selected-year-row" : ""}">
        <td><strong>${s.year}</strong></td>
        <td class="number">${formatHomeMoney(s.planned)}</td>
        <td class="number">${formatHomeMoney(s.paid)}</td>
        <td class="number ${variance < 0 ? "good-number" : variance > 0 ? "warn-number" : ""}">
          ${prev ? formatHomeMoney(variance) : "Base year"}
        </td>
      </tr>
    `;
  }).join("");
}

function renderPaymentTools() {
  const month = currentMonth();
  const rows  = month?.rows || [];
  els.paymentItemSelect.innerHTML = "";
  for (const row of rows) {
    const opt = document.createElement("option");
    opt.value = row.id; opt.textContent = row.item;
    els.paymentItemSelect.append(opt);
  }
  const entries = rows
    .flatMap(row => row.daily.map(p => ({
      item:   row.item,
      amount: Number(p.amount || 0),
      date:   p.date || serialToDate(p.daySerial),
    })))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 20);
  els.paymentLog.innerHTML = entries.length
    ? entries.map(e => `
        <div class="payment-entry">
          <div>
            <strong>${escapeHtml(e.item)}</strong><br />
            <small>${escapeHtml(e.date || "Workbook entry")}</small>
          </div>
          <strong>${formatHomeMoney(e.amount)}</strong>
        </div>
      `).join("")
    : `<p class="empty-state">No itemized payments recorded yet.</p>`;
}

/* ── Audit log render ────────────────────────────────────────────────── */
function renderAuditLog() {
  if (!auditLog.length) {
    els.auditLog.innerHTML = `<p class="empty-state">No changes recorded yet.</p>`;
    return;
  }
  const canUndo = isLoggedIn();
  els.auditLog.innerHTML = auditLog.map(entry => {
    const dt = new Date(entry.ts);
    const timeStr = dt.toLocaleString("en-KE", {
      day:"2-digit", month:"short", year:"numeric",
      hour:"2-digit", minute:"2-digit",
    });
    return `
      <div class="audit-entry">
        <div class="audit-entry-header">
          <span class="audit-type ${entry.type}">${entry.type}</span>
          <span class="audit-timestamp">${escapeHtml(timeStr)}</span>
          <button
            class="undo-btn icon-button"
            data-undo="${entry.id}"
            ${canUndo ? "" : "disabled title='Sign in to undo'"}
          >↩ Undo</button>
        </div>
        <span class="audit-desc">${escapeHtml(entry.desc)}</span>
      </div>
    `;
  }).join("");
}

/* ── Form actions ────────────────────────────────────────────────────── */
function clearForm() {
  els.entryForm.reset();
  els.entryId.value = "";
  els.formTitle.textContent = "Add budget item";
}

function upsertEntry(event) {
  event.preventDefault();
  if (!isLoggedIn()) return;
  const month = currentMonth();
  if (!month) return;
  const id      = els.entryId.value || makeId();
  const planned = Number(els.plannedInput.value || 0);
  const paid    = Number(els.paidInput.value    || 0);
  const entry   = normalizeRow({
    id,
    item:   els.itemInput.value,
    planned, paid,
    status: els.statusInput.value || inferStatus(planned, paid),
    daily:  month.rows.find(r => r.id === id)?.daily || [],
  });
  const existingIndex = month.rows.findIndex(r => r.id === id);
  const isEdit = existingIndex >= 0;
  pushAudit(isEdit ? "edit" : "add",
    `${isEdit ? "Edited" : "Added"} "${entry.item}" in ${month.month} — planned ${money.format(planned)}, paid ${money.format(paid)}`
  );
  if (isEdit) month.rows[existingIndex] = entry;
  else        month.rows.push(entry);
  save();
  clearForm();
  render();
}

function editEntry(id) {
  if (!isLoggedIn()) return;
  const row = currentMonth()?.rows.find(r => r.id === id);
  if (!row) return;
  els.entryId.value        = row.id;
  els.itemInput.value      = row.item;
  els.plannedInput.value   = row.planned;
  els.paidInput.value      = row.paid;
  els.statusInput.value    = row.status || inferStatus(row.planned, row.paid);
  els.formTitle.textContent = "Edit budget item";
  els.itemInput.focus();
}

function deleteEntry(id) {
  if (!isLoggedIn()) return;
  const month = currentMonth();
  if (!month) return;
  const row = month.rows.find(r => r.id === id);
  if (row) pushAudit("delete", `Deleted "${row.item}" from ${month.month}`);
  month.rows = month.rows.filter(r => r.id !== id);
  save();
  render();
}

function recordPayment(event) {
  event.preventDefault();
  if (!isLoggedIn()) return;
  const month = currentMonth();
  const row   = month?.rows.find(r => r.id === els.paymentItemSelect.value);
  if (!row) return;
  const amount = Number(els.paymentAmountInput.value || 0);
  pushAudit("payment",
    `Payment of ${money.format(amount)} for "${row.item}" on ${els.paymentDateInput.value} (${month.month})`
  );
  row.daily.push({ date: els.paymentDateInput.value, amount });
  row.paid      += amount;
  row.balance    = row.planned - row.paid;
  row.percentage = row.planned ? row.paid / row.planned : 0;
  row.status     = inferStatus(row.planned, row.paid);
  els.paymentForm.reset();
  els.paymentDateInput.valueAsDate = new Date();
  save();
  render();
}

function addMonth() {
  const name = formatMonthInput(els.newMonthInput.value);
  if (!name || state.data.monthData.some(m => m.month === name)) return;
  state.data.monthData.push({ month: name, rows: [] });
  state.data.monthData.sort((a, b) => monthSortValue(a.month) - monthSortValue(b.month));
  state.selectedYear  = monthYear(name);
  state.selectedMonth = name;
  els.newMonthInput.value = "";
  save();
  clearForm();
  render();
}

function formatMonthInput(value) {
  if (!value) return "";
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return "";
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/* ── Export / PDF ────────────────────────────────────────────────────── */
function exportCsv() {
  const header = ["Month","Item","Planned","Paid","Balance","Percentage","Status"];
  const lines  = [header, ...state.data.monthData.flatMap(m =>
    m.rows.map(row => [
      m.month, row.item, row.planned, row.paid,
      row.planned - row.paid,
      row.planned ? row.paid / row.planned : 0,
      inferStatus(row.planned, row.paid),
    ]),
  )];
  const csv = lines.map(l => l.map(csvValue).join(",")).join("\n");
  download("budget-tracker-export.csv", csv, "text/csv");
}

function download(filename, text, type) {
  const blob   = new Blob([text], { type });
  const url    = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

function downloadPdf(filename, title, sections) {
  const lines = buildPdfLines(title, sections);
  const pdf   = createSimplePdf(lines);
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i);
  const blob   = new Blob([bytes], { type: "application/pdf" });
  const url    = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; anchor.click();
  URL.revokeObjectURL(url);
}

function buildPdfLines(title, sections) {
  const lines = [SYSTEM_NAME, title, `Generated: ${new Date().toLocaleString()}`, ""];
  for (const section of sections) {
    if (section.heading) lines.push(section.heading);
    for (const line of section.lines) lines.push(line);
    lines.push("");
  }
  return lines;
}

function createSimplePdf(lines) {
  const pageSize = 44;
  const pages    = [];
  for (let i = 0; i < lines.length; i += pageSize) pages.push(lines.slice(i, i + pageSize));
  const objects  = ["<< /Type /Catalog /Pages 2 0 R >>"];
  const kids     = pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((pageLines, index) => {
    const po = 3 + index * 2, co = po + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pages.length * 2} 0 R >> >> /Contents ${co} 0 R >>`);
    const stream = makePdfTextStream(pageLines);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach(o => { pdf += `${String(o).padStart(10,"0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

function makePdfTextStream(lines) {
  const cmds = ["BT","/F1 11 Tf","50 750 Td","14 TL"];
  lines.forEach((line, i) => {
    const safe = escapePdf(String(line).slice(0, 95));
    cmds.push(i === 0 ? `(${safe}) Tj` : `T* (${safe}) Tj`);
  });
  cmds.push("ET");
  return cmds.join("\n");
}

function escapePdf(v) {
  return v.replaceAll("\\","\\\\").replaceAll("(","\\(").replaceAll(")","\\)");
}

function downloadMonthlyPdf() {
  const month = currentMonth();
  if (!month) return;
  const planned = sum(month.rows, "planned");
  const paid    = sum(month.rows, "paid");
  const balance = planned - paid;
  const paymentLines = month.rows.flatMap(row =>
    row.daily.map(p => ({
      item:   row.item,
      date:   p.date || serialToDate(p.daySerial) || "Workbook entry",
      amount: Number(p.amount || 0),
    })),
  );
  paymentLines.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const lines = [
    `Planned: ${money.format(planned)}    Paid: ${money.format(paid)}    Balance: ${money.format(balance)}`,
    "",
    "Item | Planned | Paid | Balance | Status",
    ...month.rows.map(r =>
      `${r.item} | ${money.format(r.planned)} | ${money.format(r.paid)} | ${money.format(r.planned - r.paid)} | ${inferStatus(r.planned, r.paid)}`
    ),
    "","Payment dates within the month",
    ...(paymentLines.length
      ? paymentLines.map(p => `${p.date} | ${p.item} | ${money.format(p.amount)}`)
      : ["No dated payment entries recorded for this month."]),
  ];
  downloadPdf(`geobonn-monthly-report-${slug(month.month)}.pdf`,
    `${month.month} Monthly Report`, [{ heading: "Monthly Summary", lines }]);
}

function downloadExpensePdf() {
  const months     = selectedYearMonths();
  const yearPlanned = months.reduce((t, m) => t + sum(m.rows, "planned"), 0);
  const yearPaid    = months.reduce((t, m) => t + sum(m.rows, "paid"),    0);
  const lines = [
    `Year: ${state.selectedYear}`,
    `Overall planned: ${money.format(yearPlanned)}`,
    `Overall expenditure: ${money.format(yearPaid)}`,
    `Overall balance: ${money.format(yearPlanned - yearPaid)}`,
    "","Month | Planned | Expenditure | Balance",
    ...months.map(m => {
      const p = sum(m.rows, "planned"), pd = sum(m.rows, "paid");
      return `${monthNameOnly(m.month)} | ${money.format(p)} | ${money.format(pd)} | ${money.format(p - pd)}`;
    }),
  ];
  downloadPdf(`geobonn-yearly-expenditure-${state.selectedYear}.pdf`,
    `${state.selectedYear} Yearly Expenditure Report`, [{ heading: "Yearly Summary", lines }]);
}

/* ── Utilities ───────────────────────────────────────────────────────── */
function sum(rows, key) {
  return rows.reduce((t, r) => t + Number(r[key] || 0), 0);
}
function formatHomeMoney(v) {
  return state.hideAmounts ? "KES ****" : money.format(v);
}
function getYears() {
  return [...new Set(state.data.monthData.map(m => monthYear(m.month)))].filter(Boolean).sort();
}
function getYearSummaries() {
  return getYears().map(year => {
    const months = state.data.monthData.filter(m => monthYear(m.month) === year);
    return {
      year,
      planned: months.reduce((t, m) => t + sum(m.rows, "planned"), 0),
      paid:    months.reduce((t, m) => t + sum(m.rows, "paid"),    0),
    };
  });
}
function monthYear(label)     { return String(label || "").split(/\s+/)[1] || ""; }
function monthNameOnly(label) { return String(label || "").split(/\s+/)[0] || ""; }
function csvValue(v) {
  const t = String(v ?? "");
  return /[",\n]/.test(t) ? `"${t.replaceAll('"','""')}"` : t;
}
function escapeHtml(v) {
  return String(v ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function serialToDate(serial) {
  const n = Number(serial);
  if (!n) return "";
  return new Date(Date.UTC(1899,11,30) + n * 86400000).toISOString().slice(0,10);
}
function slug(v) {
  return String(v).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
}

/* ── Firebase ────────────────────────────────────────────────────────── */
function hasFirebaseConfig() {
  const c = window.GEOBONN_FIREBASE_CONFIG;
  return Boolean(c && c.apiKey && c.projectId &&
    !String(c.apiKey).includes("PASTE_") && !String(c.projectId).includes("PASTE_"));
}

async function initFirebaseSync() {
  cloud.configured = hasFirebaseConfig();
  renderSyncStatus();
  updateEditLock();
  if (!cloud.configured) return;
  try {
    const [{ initializeApp }, authModule, firestoreModule] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js"),
    ]);
    const app   = initializeApp(window.GEOBONN_FIREBASE_CONFIG);
    cloud.auth  = authModule.getAuth(app);
    cloud.db    = firestoreModule.getFirestore(app);
    cloud.setDoc = firestoreModule.setDoc;
    cloud.onSnapshot = firestoreModule.onSnapshot;
    cloud.serverTimestamp = firestoreModule.serverTimestamp;
    cloud.doc   = firestoreModule.doc;
    cloud.enabled = true;

    authModule.onAuthStateChanged(cloud.auth, user => {
      cloud.user = user;
      if (cloud.unsubscribe) { cloud.unsubscribe(); cloud.unsubscribe = null; }
      if (!user) {
        cloud.docRef = null;
        renderSyncStatus("Live ready");
        updateEditLock();
        return;
      }
      cloud.docRef = cloud.doc(cloud.db, "users", user.uid, "budgets", "geobonn-expenditure");
      listenToCloudData();
      updateEditLock();
    });
  } catch (error) {
    renderSyncStatus("Live unavailable");
    els.syncHelp.textContent = `Firebase could not start: ${error.message}`;
  }
}

function listenToCloudData() {
  if (!cloud.docRef || !cloud.onSnapshot) return;
  renderSyncStatus("Going live...");
  cloud.unsubscribe = cloud.onSnapshot(cloud.docRef, snapshot => {
    if (snapshot.exists()) {
      const remote = snapshot.data()?.budget;
      if (remote?.monthData) {
        cloud.applyingRemote = true;
        state.data = normalizeData(remote);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
        if (!selectedYearMonths().some(m => m.month === state.selectedMonth)) setInitialPeriod();
        cloud.applyingRemote = false;
        render();
      }
    } else {
      queueCloudSave(true);
    }
    renderSyncStatus("Live");
  }, error => {
    renderSyncStatus("Live error");
    els.syncHelp.textContent = error.message;
  });
}

function queueCloudSave(immediate = false) {
  if (cloud.applyingRemote || !cloud.enabled || !cloud.user || !cloud.docRef || !cloud.setDoc) return;
  clearTimeout(cloud.saveTimer);
  const run = async () => {
    try {
      renderSyncStatus("Saving...");
      await cloud.setDoc(cloud.docRef, {
        budget: state.data,
        updatedAt: cloud.serverTimestamp ? cloud.serverTimestamp() : new Date().toISOString(),
      }, { merge: true });
      renderSyncStatus("Live");
    } catch (error) {
      renderSyncStatus("Live save failed");
      els.syncHelp.textContent = error.message;
    }
  };
  if (immediate) run();
  else cloud.saveTimer = setTimeout(run, 450);
}

async function signIn() {
  if (!cloud.auth) return;
  const { signInWithEmailAndPassword } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js");
  await signInWithEmailAndPassword(cloud.auth, els.emailInput.value.trim(), els.passwordInput.value);
}
async function signUp() {
  if (!cloud.auth) return;
  const { createUserWithEmailAndPassword } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js");
  await createUserWithEmailAndPassword(cloud.auth, els.emailInput.value.trim(), els.passwordInput.value);
}
async function signOut() {
  if (!cloud.auth) return;
  const { signOut: fbSignOut } = await import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js");
  await fbSignOut(cloud.auth);
}
async function handleAuth(action) {
  try {
    renderSyncStatus("Working...");
    await action();
    els.passwordInput.value = "";
    closeAuthModal();
  } catch (error) {
    renderSyncStatus("Authentication failed");
    els.syncHelp.textContent = error.message;
  }
}

function openAuthModal()  { els.authModal.hidden = false; els.emailInput.focus(); }
function closeAuthModal() { els.authModal.hidden = true; }

/* ── Event listeners ─────────────────────────────────────────────────── */
els.yearSelect.addEventListener("change", () => {
  state.selectedYear  = els.yearSelect.value;
  state.selectedMonth = selectedYearMonths()[0]?.month || "";
  clearForm(); render();
});
els.monthSelect.addEventListener("change", () => {
  state.selectedMonth = els.monthSelect.value;
  clearForm(); render();
});
els.addMonthBtn.addEventListener("click", addMonth);
els.resetBtn.addEventListener("click", async () => {
  localStorage.removeItem(STORAGE_KEY);
  await loadInitialData(true);
  clearForm(); render();
});
els.entryForm.addEventListener("submit", upsertEntry);
els.clearFormBtn.addEventListener("click", clearForm);
els.searchInput.addEventListener("input", () => {
  state.query = els.searchInput.value;
  renderItems();
});
els.itemsBody.addEventListener("click", event => {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "edit")   editEntry(btn.dataset.id);
  if (btn.dataset.action === "delete") deleteEntry(btn.dataset.id);
});
els.paymentForm.addEventListener("submit", recordPayment);
els.exportCsvBtn.addEventListener("click", exportCsv);
els.monthlyPdfBtn.addEventListener("click", downloadMonthlyPdf);
els.expensePdfBtn.addEventListener("click", downloadExpensePdf);
els.hideAmountsInput.addEventListener("change", () => {
  state.hideAmounts = els.hideAmountsInput.checked;
  render();
});
els.openAuthBtn.addEventListener("click", openAuthModal);
els.closeAuthBtn.addEventListener("click", closeAuthModal);
els.authModal.addEventListener("click", e => {
  if (e.target.matches("[data-close-auth]")) closeAuthModal();
});
els.signInBtn.addEventListener("click", () => handleAuth(signIn));
els.signUpBtn.addEventListener("click", () => handleAuth(signUp));
els.signOutBtn.addEventListener("click", () => handleAuth(signOut));

// Undo button delegation
els.auditLog.addEventListener("click", e => {
  const btn = e.target.closest("button[data-undo]");
  if (!btn || !isLoggedIn()) return;
  if (confirm("Undo this change? All newer changes will also be reverted.")) {
    undoAudit(btn.dataset.undo);
  }
});

// Clear audit log
els.clearAuditBtn.addEventListener("click", () => {
  if (confirm("Clear the entire change history? This cannot be undone.")) {
    auditLog = [];
    saveAudit();
    renderAuditLog();
  }
});

/* ── Boot ────────────────────────────────────────────────────────────── */
els.paymentDateInput.valueAsDate = new Date();
loadAudit();
loadInitialData()
  .then(async () => {
    render();
    await initFirebaseSync();
  })
  .catch(error => {
    document.body.innerHTML = `<main class="layout"><section class="panel"><h1>Unable to load tracker data</h1><p>${escapeHtml(error.message)}</p></section></main>`;
  });
