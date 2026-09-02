import { useState, useMemo, useRef, useEffect } from "react";
import { storage } from "./storage";
import Papa from "papaparse";

// ---------- helpers ----------

function getField(row, keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== "") return row[k];
  }
  return "";
}

function parseAnyDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  let d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = "20" + y;
    d = new Date(Number(y), Number(b) - 1, Number(a));
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function monthKey(dateStr) {
  return dateStr.slice(0, 7); // YYYY-MM
}

function formatMonthLabel(mKey) {
  const d = new Date(mKey + "-01T00:00:00");
  return d.toLocaleDateString("id-ID", { month: "long", year: "numeric" });
}

function formatDateLabel(key) {
  const d = new Date(key + "T00:00:00");
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
}

function fmtRp(n) {
  if (n === undefined || n === null || isNaN(n)) return "-";
  const neg = n < 0;
  const v = Math.abs(Math.round(n)).toLocaleString("id-ID");
  return (neg ? "(" : "") + "Rp " + v + (neg ? ")" : "");
}

function fmtPct(n) {
  if (n === undefined || n === null || isNaN(n)) return "-";
  return n.toLocaleString("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
}

function toNumber(v) {
  if (typeof v === "number") return v;
  if (!v) return 0;
  const cleaned = String(v).replace(/[^0-9,.\-]/g, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// ---------- parsers per source type ----------

function parseOrderLog(rows) {
  const byDate = {};
  for (const row of rows) {
    const dt = parseAnyDate(getField(row, ["Order Time", "order time"]));
    if (!dt) continue;
    const key = dateKey(dt);
    const total = toNumber(getField(row, ["Total Product", "total product"]));
    byDate[key] = (byDate[key] || 0) + total;
  }
  return byDate;
}

function parseBankMutasi(rows) {
  const byDate = {};
  for (const row of rows) {
    const dt = parseAnyDate(getField(row, ["Tanggal", "tanggal"]));
    if (!dt) continue;
    const key = dateKey(dt);
    const jumlah = toNumber(getField(row, ["JUMLAH", "Jumlah", "Mutasi"]));
    const dbcr = String(getField(row, ["DB/CR", "Dari/Untuk", "Db/Cr"])).toUpperCase();
    const saldo = toNumber(getField(row, ["SALDO", "Saldo"]));
    if (!byDate[key]) byDate[key] = { debit: 0, kredit: 0, saldoAkhir: 0 };
    if (dbcr.startsWith("D")) byDate[key].debit += jumlah;
    else byDate[key].kredit += jumlah;
    if (saldo) byDate[key].saldoAkhir = saldo;
  }
  return byDate;
}

function parseXendit(rows) {
  const byDate = {};
  for (const row of rows) {
    const dt = parseAnyDate(getField(row, ["Created Date", "Completed Date", "Payment Date"]));
    if (!dt) continue;
    const key = dateKey(dt);
    const amount = toNumber(getField(row, ["Amount"]));
    const dbcr = String(getField(row, ["Debit or Credit"])).toUpperCase();
    const balance = toNumber(getField(row, ["Balance"]));
    if (!byDate[key]) byDate[key] = { debit: 0, kredit: 0, saldoAkhir: 0 };
    if (dbcr.startsWith("D")) byDate[key].debit += amount;
    else byDate[key].kredit += amount;
    if (balance) byDate[key].saldoAkhir = balance;
  }
  return byDate;
}

// ---------- config ----------

const ORDER_LOG_SLOTS = [
  { id: "physical", label: "Order Log Physical" },
  { id: "logical", label: "Order Log Logical" },
  { id: "wg", label: "Order Log WG" },
];

// the 7 elements that make up Modal Kerja
const MK_ELEMENTS = [
  { id: "bank", label: "Dana Bank", auto: true },
  { id: "xendit", label: "Xendit", auto: true },
  { id: "logical", label: "Logical", auto: false },
  { id: "fisik", label: "Fisik", auto: false },
  { id: "attack", label: "Product Attack", auto: false },
  { id: "eload", label: "Eload", auto: false },
  { id: "stockWG", label: "Stock WG", auto: false },
];
const MANUAL_ELEMENTS = MK_ELEMENTS.filter((e) => !e.auto);

// order used on the "Modal Kerja" summary tab (matches source layout)
const MK_SUMMARY_ORDER = ["bank", "xendit", "logical", "attack", "eload", "stockWG", "fisik"];

// variance-explanation fields (Selisih Kurang / Selisih Lebih breakdown)
const ADJUSTMENT_FIELDS = [
  { id: "adminBank", label: "Admin Bank & Talangan", group: "kurang" },
  { id: "vatFee", label: "VAT & Fee", group: "kurang" },
  { id: "danaTalangan", label: "Dana Talangan & Event", group: "kurang" },
  { id: "program", label: "PROGRAM", group: "kurang" },
  { id: "xenditPending", label: "Xendit Pending", group: "kurang" },
  { id: "selisihDiscSpsPr", label: "Selisih Disc Sps Pr", group: "kurang" },
  { id: "kurangBayar", label: "Kurang Bayar", group: "kurang" },
  { id: "margin", label: "Margin", group: "lebih" },
  { id: "lebihBayar", label: "Lebih Bayar", group: "lebih" },
  { id: "saldoAwalRekening", label: "Saldo Awal Rekening", group: "lebih" },
];
const KURANG_FIELDS = ADJUSTMENT_FIELDS.filter((f) => f.group === "kurang");
const LEBIH_FIELDS = ADJUSTMENT_FIELDS.filter((f) => f.group === "lebih");

function emptyOpening() {
  const o = { bulan: "" };
  MK_ELEMENTS.forEach((e) => (o[e.id] = ""));
  return o;
}

function emptyCluster() {
  return {
    orderLog: { physical: {}, logical: {}, wg: {} },
    orderLogFiles: {},
    banks: {},
    xendit: { byDate: {}, fileName: null, rowCount: 0 },
    manual: {},
    opening: emptyOpening(),
    activePeriod: null,
  };
}

function summarizeCluster(c) {
  const dates = new Set();
  Object.values(c.orderLog || {}).forEach((m) => Object.keys(m).forEach((d) => dates.add(d)));
  Object.values(c.banks || {}).forEach((b) => Object.keys(b.byDate).forEach((d) => dates.add(d)));
  Object.keys(c.xendit?.byDate || {}).forEach((d) => dates.add(d));
  Object.keys(c.manual || {}).forEach((d) => dates.add(d));
  const sorted = Array.from(dates).sort();
  const last = sorted[sorted.length - 1];
  const openingTotal = MK_ELEMENTS.reduce((s, e) => s + toNumber(c.opening?.[e.id]), 0);
  const elementsAtClose = {};
  let actualLast = 0;
  if (last) {
    let bankTotal = 0;
    Object.values(c.banks || {}).forEach((b) => (bankTotal += b.byDate[last]?.saldoAkhir || 0));
    const xenditLast = c.xendit?.byDate?.[last]?.saldoAkhir || 0;
    elementsAtClose.bank = bankTotal;
    elementsAtClose.xendit = xenditLast;
    let manualSum = 0;
    MANUAL_ELEMENTS.forEach((e) => {
      const v = toNumber((c.manual?.[last] || {})[e.id]);
      elementsAtClose[e.id] = v;
      manualSum += v;
    });
    actualLast = bankTotal + xenditLast + manualSum;
  }
  return {
    dateCount: sorted.length,
    firstDate: sorted[0],
    lastDate: last,
    openingTotal,
    actualLast,
    selisih: actualLast - openingTotal,
    elementsAtClose,
  };
}

// ---------- small UI atoms ----------

function UploadCard({ title, hint, fileName, rowCount, onFile }) {
  const inputRef = useRef(null);
  return (
    <div className="uc">
      <div className="uc-top">
        <div>
          <div className="uc-title">{title}</div>
          <div className="uc-hint">{hint}</div>
        </div>
        <button className="uc-btn" onClick={() => inputRef.current?.click()}>
          {fileName ? "Ganti file" : "Pilih file"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = "";
          }}
        />
      </div>
      {fileName ? (
        <div className="uc-status uc-status-ok">
          {fileName} &middot; {rowCount.toLocaleString("id-ID")} baris terbaca
        </div>
      ) : (
        <div className="uc-status uc-status-empty">Belum ada file diunggah</div>
      )}
    </div>
  );
}

function Row({ label, values, dates, fmt = fmtRp, tone, band, indent, italic }) {
  const cls = ["lrow"];
  if (band) cls.push("band-" + band);
  if (indent) cls.push("lrow-indent");
  if (italic) cls.push("lrow-italic");
  return (
    <tr className={cls.join(" ")}>
      <td className="lr-label">{label}</td>
      {dates.map((d) => {
        const v = values[d];
        const signCls = tone === "signed" ? (v < 0 ? "lr-neg" : v > 0 ? "lr-pos" : "") : "";
        return (
          <td key={d} className={"lr-val " + signCls}>
            {v === undefined ? "-" : fmt(v)}
          </td>
        );
      })}
    </tr>
  );
}

function LabelOnlyRow({ label, dates, band }) {
  const cls = ["lrow"];
  if (band) cls.push("band-" + band);
  return (
    <tr className={cls.join(" ")}>
      <td className="lr-label">{label}</td>
      {dates.map((d) => (
        <td key={d} className="lr-val" />
      ))}
    </tr>
  );
}

// ---------- main component ----------

export default function ModalKerjaPrototype() {
  const [clusters, setClusters] = useState(["EJ Makassar Greater"]);
  const [activeCluster, setActiveCluster] = useState("EJ Makassar Greater");
  const [newCluster, setNewCluster] = useState("");
  const [tab, setTab] = useState("upload");

  const [store, setStore] = useState({
    "EJ Makassar Greater": emptyCluster(),
  });

  const [newBankName, setNewBankName] = useState("");
  const [bankNames, setBankNames] = useState(["BCA", "BRI"]);

  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 4;

  const [dismissedMonths, setDismissedMonths] = useState([]);
  const [saveStatus, setSaveStatus] = useState("");
  const [historyKeys, setHistoryKeys] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [viewingPeriod, setViewingPeriod] = useState(null);
  const [viewingData, setViewingData] = useState(null);
  const [viewingLoading, setViewingLoading] = useState(false);

  const cData = store[activeCluster];

  function updateCluster(fn) {
    setStore((prev) => ({ ...prev, [activeCluster]: fn(prev[activeCluster]) }));
  }

  function handleOrderLogFile(slotId, file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const byDate = parseOrderLog(res.data);
        updateCluster((c) => ({
          ...c,
          orderLog: { ...c.orderLog, [slotId]: byDate },
          orderLogFiles: { ...c.orderLogFiles, [slotId]: { name: file.name, rows: res.data.length } },
        }));
      },
    });
  }

  function handleBankFile(bankName, file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const byDate = parseBankMutasi(res.data);
        updateCluster((c) => ({
          ...c,
          banks: { ...c.banks, [bankName]: { byDate, fileName: file.name, rowCount: res.data.length } },
        }));
      },
    });
  }

  function handleXenditFile(file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const byDate = parseXendit(res.data);
        updateCluster((c) => ({ ...c, xendit: { byDate, fileName: file.name, rowCount: res.data.length } }));
      },
    });
  }

  function setManual(key, field, value) {
    updateCluster((c) => ({
      ...c,
      manual: { ...c.manual, [key]: { ...(c.manual[key] || {}), [field]: value } },
    }));
  }

  function setOpening(field, value) {
    updateCluster((c) => ({ ...c, opening: { ...c.opening, [field]: value } }));
  }

  const openingTotal = MK_ELEMENTS.reduce((sum, e) => sum + toNumber(cData.opening[e.id]), 0);

  const allDates = useMemo(() => {
    const s = new Set();
    Object.values(cData.orderLog).forEach((m) => Object.keys(m).forEach((d) => s.add(d)));
    Object.values(cData.banks).forEach((b) => Object.keys(b.byDate).forEach((d) => s.add(d)));
    Object.keys(cData.xendit.byDate).forEach((d) => s.add(d));
    Object.keys(cData.manual).forEach((d) => s.add(d));
    return Array.from(s).sort();
  }, [cData]);

  const hasData = allDates.length > 0;
  const calcDates = hasData ? allDates : [dateKey(new Date())];

  // init activePeriod as soon as the cluster has its first date
  useEffect(() => {
    if (!cData.activePeriod && allDates.length > 0) {
      updateCluster((c) => (c.activePeriod ? c : { ...c, activePeriod: monthKey(allDates[0]) }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCluster, allDates.length]);

  const detectedMonths = Array.from(new Set(allDates.map(monthKey))).sort();
  const pendingNewMonth =
    cData.activePeriod && detectedMonths.find((m) => m !== cData.activePeriod && !dismissedMonths.includes(m));

  // autosave current cluster's working sheet to persistent storage, debounced
  useEffect(() => {
    if (!cData.activePeriod) return;
    const key = "mk:" + activeCluster + ":" + cData.activePeriod;
    const payload = JSON.stringify(cData);
    setSaveStatus("Menyimpan...");
    const t = setTimeout(async () => {
      try {
        const res = await storage.set(key, payload, false);
        setSaveStatus(res ? "Tersimpan otomatis · " + new Date().toLocaleTimeString("id-ID") : "Gagal menyimpan");
      } catch (err) {
        setSaveStatus("Gagal menyimpan");
      }
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(cData), activeCluster]);

  async function handleStartNewMonth() {
    if (!pendingNewMonth) return;
    // carry the closing balance of the old sheet forward as the new opening
    const closing = {};
    MK_ELEMENTS.forEach((e) => (closing[e.id] = elementActual[e.id]?.[lastDate] || 0));
    updateCluster(() => ({
      ...emptyCluster(),
      opening: { ...emptyOpening(), ...closing },
      activePeriod: pendingNewMonth,
    }));
    setDismissedMonths((prev) => prev.filter((m) => m !== pendingNewMonth));
    setSaveStatus("Lembar kerja baru dibuat untuk " + formatMonthLabel(pendingNewMonth));
  }

  async function loadHistory() {
    setHistoryLoading(true);
    try {
      const res = await storage.list("mk:" + activeCluster + ":", false);
      setHistoryKeys(res?.keys || []);
    } catch (err) {
      setHistoryKeys([]);
    }
    setHistoryLoading(false);
  }

  async function viewPeriod(key) {
    setViewingLoading(true);
    setViewingPeriod(key);
    try {
      const res = await storage.get(key, false);
      setViewingData(res ? JSON.parse(res.value) : null);
    } catch (err) {
      setViewingData(null);
    }
    setViewingLoading(false);
  }

  // reconciliation: omset vs uang masuk
  const omset = {};
  const uangMasuk = {};
  calcDates.forEach((d) => {
    omset[d] =
      (cData.orderLog.physical[d] || 0) + (cData.orderLog.logical[d] || 0) + (cData.orderLog.wg[d] || 0);
    let masuk = 0;
    Object.values(cData.banks).forEach((b) => (masuk += b.byDate[d]?.kredit || 0));
    masuk += cData.xendit.byDate[d]?.kredit || 0;
    uangMasuk[d] = masuk;
  });
  const selisihOmset = {};
  calcDates.forEach((d) => (selisihOmset[d] = omset[d] - uangMasuk[d]));

  // per-element actual values per date
  const saldoBankPerBank = {};
  const elementActual = { bank: {}, xendit: {}, logical: {}, fisik: {}, attack: {}, eload: {}, stockWG: {} };
  calcDates.forEach((d) => {
    let total = 0;
    Object.entries(cData.banks).forEach(([name, b]) => {
      const v = b.byDate[d]?.saldoAkhir || 0;
      saldoBankPerBank[name] = saldoBankPerBank[name] || {};
      saldoBankPerBank[name][d] = v;
      total += v;
    });
    elementActual.bank[d] = total;
    elementActual.xendit[d] = cData.xendit.byDate[d]?.saldoAkhir || 0;
    MANUAL_ELEMENTS.forEach((e) => {
      elementActual[e.id][d] = toNumber((cData.manual[d] || {})[e.id]);
    });
  });

  const actualMK = {};
  calcDates.forEach((d) => {
    actualMK[d] = MK_ELEMENTS.reduce((sum, e) => sum + (elementActual[e.id][d] || 0), 0);
  });

  const stockTotal = {};
  const digitalTotal = {};
  calcDates.forEach((d) => {
    digitalTotal[d] = elementActual.attack[d] + elementActual.eload[d] + elementActual.stockWG[d];
    stockTotal[d] = elementActual.fisik[d] + elementActual.logical[d] + digitalTotal[d];
  });

  // target per date = opening total (Modal Kerja awal bulan is flat for the whole month)
  const targetMK = {};
  calcDates.forEach((d) => (targetMK[d] = openingTotal));

  const vsActual = {};
  const selisihAbs = {};
  const selisihKurang = {};
  const selisihLebih = {};
  calcDates.forEach((d) => {
    vsActual[d] = actualMK[d] - targetMK[d];
    selisihAbs[d] = Math.abs(vsActual[d]);
    const m = cData.manual[d] || {};
    selisihKurang[d] = KURANG_FIELDS.reduce((s, f) => s + toNumber(m[f.id]), 0);
    selisihLebih[d] = LEBIH_FIELDS.reduce((s, f) => s + toNumber(m[f.id]), 0);
  });

  const bankList = Object.keys(cData.banks);

  const rangeFilteredDates = calcDates.filter((d) => {
    if (rangeFrom && d < rangeFrom) return false;
    if (rangeTo && d > rangeTo) return false;
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(rangeFilteredDates.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const visibleDates = rangeFilteredDates.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  // element % share of the opening target, for the "Modal Kerja" summary tab header
  const elementPct = {};
  MK_SUMMARY_ORDER.forEach((id) => {
    elementPct[id] = openingTotal > 0 ? (toNumber(cData.opening[id]) / openingTotal) * 100 : 0;
  });
  const lastDate = calcDates[calcDates.length - 1];

  return (
    <div className="mk-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

        .mk-root {
          --ink: #524646;
          --ink-2: #5c5050;
          --paper: #fcf2e5;
          --paper-2: #fff9f1;
          --rule: #6e615d;
          --rule-soft: #ecdfc9;
          --accent: #ec5b38;
          --accent-deep: #c94a2c;
          --slate: #a8a492;
          --warn: #ec5b38;
          --ink-text: #fcf2e5;
          --ink-text-dim: #a8a492;
          --band-a: #a8a492;
          --band-b: #fcf2e5;
          --band-c: #ec5b38;
          font-family: 'Inter', sans-serif;
          background: var(--ink);
          color: var(--ink-text);
          min-height: 100%;
        }
        .mk-shell { display: grid; grid-template-columns: 220px 1fr; min-height: 100%; }
        .mk-rail { background: var(--ink-2); border-right: 1px solid var(--rule); padding: 20px 16px; display: flex; flex-direction: column; gap: 22px; }
        .mk-brand { font-size: 14px; letter-spacing: 0.02em; color: var(--ink-text); line-height: 1.4; }
        .mk-brand b { color: var(--accent); font-weight: 700; }
        .mk-section-label { font-size: 11px; color: var(--ink-text-dim); margin-bottom: 8px; }
        .mk-cluster-list { display: flex; flex-direction: column; gap: 4px; }
        .mk-cluster-item { text-align: left; background: none; border: none; color: var(--ink-text-dim); padding: 7px 10px; border-radius: 3px; font-size: 13.5px; cursor: pointer; }
        .mk-cluster-item.active { background: var(--rule); color: var(--ink-text); font-weight: 600; }
        .mk-add-row { display: flex; gap: 6px; margin-top: 6px; }
        .mk-add-row input { flex: 1; min-width: 0; background: var(--ink); border: 1px solid var(--rule); color: var(--ink-text); font-size: 12.5px; padding: 6px 7px; border-radius: 3px; }
        .mk-add-row button { background: none; border: 1px solid var(--rule); color: var(--accent); font-size: 12.5px; padding: 6px 9px; border-radius: 3px; cursor: pointer; }
        .mk-note { font-size: 11.5px; color: var(--ink-text-dim); line-height: 1.5; border-top: 1px solid var(--rule); padding-top: 14px; margin-top: auto; }

        .mk-main { padding: 28px 36px 60px; }
        .mk-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 4px; }
        .mk-h1 { font-size: 22px; font-weight: 700; color: var(--ink-text); }
        .mk-sub { font-size: 13px; color: var(--ink-text-dim); margin-bottom: 22px; }

        .mk-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--rule); margin-bottom: 24px; }
        .mk-tab { background: none; border: none; color: var(--ink-text-dim); font-size: 13.5px; padding: 9px 14px; cursor: pointer; border-bottom: 2px solid transparent; }
        .mk-tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }

        .mk-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .uc { background: var(--paper); color: #524646; border-radius: 4px; padding: 14px 16px; border: 1px solid var(--rule-soft); }
        .uc-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .uc-title { font-weight: 600; font-size: 14px; }
        .uc-hint { font-size: 11.5px; color: #a8a492; margin-top: 2px; }
        .uc-btn { background: var(--accent); color: #fff; border: none; padding: 7px 12px; border-radius: 3px; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
        .uc-btn:hover { background: var(--accent-deep); }
        .uc-status { margin-top: 10px; font-size: 12px; font-family: 'IBM Plex Mono', monospace; }
        .uc-status-ok { color: var(--slate); }
        .uc-status-empty { color: #a8a492; }

        .mk-bank-adder { display: flex; gap: 8px; align-items: center; margin: 18px 0 12px; }
        .mk-bank-adder input { background: var(--paper); border: 1px solid var(--rule-soft); padding: 7px 9px; border-radius: 3px; font-size: 13px; color: #524646; }
        .mk-bank-adder button { background: none; border: 1px solid var(--rule); color: var(--accent); padding: 7px 12px; border-radius: 3px; font-size: 13px; cursor: pointer; }

        .mk-table-wrap { overflow-x: auto; border: 1px solid var(--rule); border-radius: 4px; }
        table.mk-ledger { border-collapse: collapse; width: 100%; font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; background: var(--ink-2); }
        table.mk-ledger th, table.mk-ledger td { padding: 7px 12px; border-bottom: 1px solid var(--rule); white-space: nowrap; }
        table.mk-ledger th { text-align: right; color: var(--ink-text-dim); font-weight: 500; font-family: 'Inter', sans-serif; font-size: 12px; }
        table.mk-ledger th:first-child, table.mk-ledger td.lr-label { text-align: left; font-family: 'Inter', sans-serif; color: var(--ink-text); position: sticky; left: 0; background: var(--ink-2); }
        td.lr-val { text-align: right; color: var(--ink-text); }
        td.lr-neg { color: #ec5b38; }
        td.lr-pos { color: #a8a492; }
        .lrow-indent td.lr-label { color: var(--ink-text-dim); padding-left: 24px; }
        .lrow-italic td.lr-label { font-style: italic; }

        .band-teal td { background: var(--band-a); color: #524646; font-weight: 600; }
        .band-teal td.lr-label { background: var(--band-a); position: sticky; left: 0; }
        .band-purple td { background: var(--band-b); color: #524646; font-weight: 700; }
        .band-purple td.lr-label { background: var(--band-b); position: sticky; left: 0; }
        .band-yellow td { background: var(--band-c); color: #fcf2e5; font-weight: 700; }
        .band-yellow td.lr-label { background: var(--band-c); position: sticky; left: 0; }
        .band-plain td.lr-label { color: var(--slate); font-style: italic; }

        .mk-section-title { font-size: 13px; color: var(--ink-text-dim); margin: 26px 0 8px; }

        .mk-opening-box { background: var(--paper); border: 1px solid var(--rule-soft); border-radius: 4px; padding: 16px 18px; }
        .mk-opening-topline { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
        .mk-opening-topline label { font-size: 12px; color: #a8a492; }
        .mk-opening-topline input { background: var(--paper-2); border: 1px solid var(--rule-soft); padding: 6px 9px; border-radius: 3px; font-size: 13px; color: #524646; width: 180px; }
        .mk-opening-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
        .mk-opening-field { display: flex; flex-direction: column; gap: 4px; }
        .mk-opening-field label { font-size: 11px; color: #a8a492; }
        .mk-opening-field input { border: 1px solid var(--rule-soft); background: var(--paper-2); font-family: 'IBM Plex Mono', monospace; font-size: 13px; padding: 6px 8px; border-radius: 3px; color: #524646; }
        .mk-opening-total { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--rule-soft); display: flex; justify-content: space-between; font-family: 'IBM Plex Mono', monospace; font-size: 13.5px; color: #524646; font-weight: 600; }

        .mk-manual-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin-top: 10px; }
        .mk-manual-cell { background: var(--paper); border-radius: 4px; padding: 10px 11px; border: 1px solid var(--rule-soft); }
        .mk-manual-date { font-size: 11.5px; color: #a8a492; margin-bottom: 6px; font-family: 'IBM Plex Mono', monospace; }
        .mk-manual-field { display: flex; flex-direction: column; gap: 2px; margin-bottom: 7px; }
        .mk-manual-field label { font-size: 10.5px; color: #a8a492; }
        .mk-manual-field input { border: 1px solid var(--rule-soft); background: var(--paper-2); font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; padding: 4px 6px; border-radius: 3px; color: #524646; }
        .mk-manual-subhead { font-size: 10px; text-transform: none; color: #a8a492; margin: 6px 0 3px; border-top: 1px dashed var(--rule-soft); padding-top: 6px; }

        .mk-pct-row th { color: var(--accent); font-weight: 700; }
        .mk-grand-total td { background: #f5e6d0; color: var(--ink-text); font-weight: 700; border-top: 2px solid var(--rule); }
        .mk-grand-total td.lr-label { background: #f5e6d0; }

        .mk-empty { color: var(--ink-text-dim); font-size: 13px; padding: 30px 4px; }

        .mk-save-status { font-size: 11.5px; color: var(--ink-text-dim); font-family: 'IBM Plex Mono', monospace; }
        .mk-save-status b { color: var(--ink-text); font-family: 'Inter', sans-serif; }

        .mk-banner { background: var(--band-b); color: #524646; border-radius: 4px; padding: 14px 16px; margin: 14px 0 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; font-size: 13px; line-height: 1.5; }
        .mk-banner-actions { display: flex; gap: 8px; flex-shrink: 0; }
        .mk-banner-btn-primary { background: #524646; color: #fcf2e5; border: none; padding: 8px 14px; border-radius: 3px; font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap; }
        .mk-banner-btn { background: none; border: 1px solid #524646; color: #524646; padding: 8px 12px; border-radius: 3px; font-size: 12.5px; cursor: pointer; white-space: nowrap; }

        .mk-history-grid { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 20px; }
        .mk-history-item { background: var(--paper); border: 1px solid var(--rule-soft); color: #524646; padding: 8px 14px; border-radius: 3px; font-size: 12.5px; cursor: pointer; }
        .mk-history-item.active { background: var(--accent); color: #fcf2e5; border-color: var(--accent); font-weight: 600; }

        .mk-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; }
        .mk-toolbar-range { display: flex; align-items: center; gap: 8px; }
        .mk-toolbar-range label { font-size: 11.5px; color: var(--ink-text-dim); }
        .mk-toolbar-range input { background: var(--paper); border: 1px solid var(--rule-soft); color: #524646; font-size: 12.5px; padding: 5px 7px; border-radius: 3px; font-family: 'IBM Plex Mono', monospace; }
        .mk-toolbar-reset { background: none; border: 1px solid var(--rule); color: var(--accent); font-size: 12px; padding: 5px 9px; border-radius: 3px; cursor: pointer; }
        .mk-toolbar-pager { display: flex; align-items: center; gap: 10px; font-size: 12.5px; font-family: 'IBM Plex Mono', monospace; color: var(--ink-text-dim); }
        .mk-toolbar-pager button { background: var(--ink-2); border: 1px solid var(--rule); color: var(--ink-text); font-size: 12px; padding: 6px 10px; border-radius: 3px; cursor: pointer; font-family: 'Inter', sans-serif; }
        .mk-toolbar-pager button:disabled { opacity: 0.35; cursor: not-allowed; }
      `}</style>

      <div className="mk-shell">
        <aside className="mk-rail">
          <div className="mk-brand">
            Ruang Kerja <b>Modal Kerja</b>
          </div>

          <div>
            <div className="mk-section-label">Cluster</div>
            <div className="mk-cluster-list">
              {clusters.map((c) => (
                <button
                  key={c}
                  className={"mk-cluster-item" + (c === activeCluster ? " active" : "")}
                  onClick={() => setActiveCluster(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="mk-add-row">
              <input placeholder="Tambah cluster..." value={newCluster} onChange={(e) => setNewCluster(e.target.value)} />
              <button
                onClick={() => {
                  const name = newCluster.trim();
                  if (!name || clusters.includes(name)) return;
                  setClusters([...clusters, name]);
                  setStore((prev) => ({ ...prev, [name]: emptyCluster() }));
                  setActiveCluster(name);
                  setNewCluster("");
                }}
              >
                +
              </button>
            </div>
          </div>

          <div className="mk-note">
            Prototipe — data tersimpan hanya selama sesi ini di browser. Versi
            produksi perlu backend + database supaya admin tiap cluster bisa
            input harian dan riwayat tiap bulan tersimpan permanen.
          </div>
        </aside>

        <main className="mk-main">
          <div className="mk-header">
            <div className="mk-h1">{activeCluster}</div>
            {cData.activePeriod && (
              <div className="mk-save-status">
                Lembar kerja: <b>{formatMonthLabel(cData.activePeriod)}</b>
                {saveStatus ? " · " + saveStatus : ""}
              </div>
            )}
          </div>
          <div className="mk-sub">Monitoring modal kerja harian — otomatis dari file yang diunggah</div>

          {pendingNewMonth && (
            <div className="mk-banner">
              <div>
                Data tanggal di bulan <b>{formatMonthLabel(pendingNewMonth)}</b> terdeteksi, sedangkan lembar kerja
                aktif masih <b>{formatMonthLabel(cData.activePeriod)}</b>. Lembar kerja {formatMonthLabel(cData.activePeriod)}{" "}
                sudah tersimpan otomatis — mulai lembar kerja baru untuk bulan berikutnya? Saldo penutupan akan
                dibawa jadi Modal Kerja Awal bulan baru.
              </div>
              <div className="mk-banner-actions">
                <button className="mk-banner-btn-primary" onClick={handleStartNewMonth}>
                  Buat Lembar Kerja Baru
                </button>
                <button
                  className="mk-banner-btn"
                  onClick={() => setDismissedMonths((prev) => [...prev, pendingNewMonth])}
                >
                  Abaikan
                </button>
              </div>
            </div>
          )}

          <div className="mk-tabs">
            <button className={"mk-tab" + (tab === "upload" ? " active" : "")} onClick={() => setTab("upload")}>
              Unggah Data
            </button>
            <button className={"mk-tab" + (tab === "summaryMK" ? " active" : "")} onClick={() => setTab("summaryMK")}>
              Summary MK
            </button>
            <button className={"mk-tab" + (tab === "modalKerja" ? " active" : "")} onClick={() => setTab("modalKerja")}>
              Modal Kerja
            </button>
            <button
              className={"mk-tab" + (tab === "riwayat" ? " active" : "")}
              onClick={() => {
                setTab("riwayat");
                loadHistory();
              }}
            >
              Riwayat Bulan
            </button>
          </div>

          {tab === "upload" && (
            <div>
              <div className="mk-section-title">
                Modal Kerja Awal Bulan — saldo akhir bulan lalu, dipecah per elemen
              </div>
              <div className="mk-opening-box">
                <div className="mk-opening-topline">
                  <label>Bulan berjalan</label>
                  <input
                    placeholder="mis. Agustus 2026"
                    value={cData.opening.bulan}
                    onChange={(e) => setOpening("bulan", e.target.value)}
                  />
                </div>
                <div className="mk-opening-grid">
                  {MK_ELEMENTS.map((e) => (
                    <div className="mk-opening-field" key={e.id}>
                      <label>{e.label}</label>
                      <input
                        type="number"
                        placeholder="0"
                        value={cData.opening[e.id]}
                        onChange={(ev) => setOpening(e.id, ev.target.value)}
                      />
                    </div>
                  ))}
                </div>
                <div className="mk-opening-total">
                  <span>Total Modal Kerja Awal</span>
                  <span>{fmtRp(openingTotal)}</span>
                </div>
              </div>

              <div className="mk-section-title">Order Log</div>
              <div className="mk-grid">
                {ORDER_LOG_SLOTS.map((slot) => (
                  <UploadCard
                    key={slot.id}
                    title={slot.label}
                    hint="Kolom wajib: Order Time, Total Product"
                    fileName={cData.orderLogFiles[slot.id]?.name}
                    rowCount={cData.orderLogFiles[slot.id]?.rows || 0}
                    onFile={(f) => handleOrderLogFile(slot.id, f)}
                  />
                ))}
              </div>

              <div className="mk-section-title">Mutasi Bank</div>
              <div className="mk-bank-adder">
                <input
                  placeholder="Nama bank baru, mis. Mandiri"
                  value={newBankName}
                  onChange={(e) => setNewBankName(e.target.value)}
                />
                <button
                  onClick={() => {
                    const name = newBankName.trim();
                    if (!name || bankNames.includes(name)) return;
                    setBankNames([...bankNames, name]);
                    setNewBankName("");
                  }}
                >
                  Tambah bank
                </button>
              </div>
              <div className="mk-grid">
                {bankNames.map((bank) => (
                  <UploadCard
                    key={bank}
                    title={"Mutasi " + bank}
                    hint="Kolom wajib: Tanggal, JUMLAH, DB/CR, SALDO"
                    fileName={cData.banks[bank]?.fileName}
                    rowCount={cData.banks[bank]?.rowCount || 0}
                    onFile={(f) => handleBankFile(bank, f)}
                  />
                ))}
              </div>

              <div className="mk-section-title">Payment Gateway</div>
              <div className="mk-grid">
                <UploadCard
                  title="Xendit"
                  hint="Kolom wajib: Created Date, Amount, Debit or Credit, Balance"
                  fileName={cData.xendit.fileName}
                  rowCount={cData.xendit.rowCount}
                  onFile={handleXenditFile}
                />
              </div>

              {allDates.length > 0 && (
                <>
                  <div className="mk-section-title">
                    Input manual per hari — Stock &amp; Digital, plus rincian selisih
                  </div>

                  <div className="mk-toolbar">
                    <div className="mk-toolbar-range">
                      <label>Dari</label>
                      <input
                        type="date"
                        value={rangeFrom}
                        onChange={(e) => {
                          setRangeFrom(e.target.value);
                          setPage(0);
                        }}
                      />
                      <label>Sampai</label>
                      <input
                        type="date"
                        value={rangeTo}
                        onChange={(e) => {
                          setRangeTo(e.target.value);
                          setPage(0);
                        }}
                      />
                      {(rangeFrom || rangeTo) && (
                        <button
                          className="mk-toolbar-reset"
                          onClick={() => {
                            setRangeFrom("");
                            setRangeTo("");
                            setPage(0);
                          }}
                        >
                          Reset filter
                        </button>
                      )}
                    </div>
                    <div className="mk-toolbar-pager">
                      <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
                        &larr; Sebelumnya
                      </button>
                      <span>
                        {rangeFilteredDates.length === 0
                          ? "Tidak ada tanggal"
                          : `${formatDateLabel(visibleDates[0])} – ${formatDateLabel(visibleDates[visibleDates.length - 1])} · hal ${safePage + 1}/${totalPages}`}
                      </span>
                      <button disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)}>
                        Berikutnya &rarr;
                      </button>
                    </div>
                  </div>

                  <div className="mk-manual-grid">
                    {visibleDates.map((d) => (
                      <div className="mk-manual-cell" key={d}>
                        <div className="mk-manual-date">{formatDateLabel(d)}</div>
                        {MANUAL_ELEMENTS.map((e) => (
                          <div className="mk-manual-field" key={e.id}>
                            <label>{e.label}</label>
                            <input
                              type="number"
                              value={cData.manual[d]?.[e.id] ?? ""}
                              onChange={(ev) => setManual(d, e.id, ev.target.value)}
                            />
                          </div>
                        ))}

                        <div className="mk-manual-subhead">Rincian Selisih Kurang</div>
                        {KURANG_FIELDS.map((f) => (
                          <div className="mk-manual-field" key={f.id}>
                            <label>{f.label}</label>
                            <input
                              type="number"
                              value={cData.manual[d]?.[f.id] ?? ""}
                              onChange={(ev) => setManual(d, f.id, ev.target.value)}
                            />
                          </div>
                        ))}

                        <div className="mk-manual-subhead">Rincian Selisih Lebih</div>
                        {LEBIH_FIELDS.map((f) => (
                          <div className="mk-manual-field" key={f.id}>
                            <label>{f.label}</label>
                            <input
                              type="number"
                              value={cData.manual[d]?.[f.id] ?? ""}
                              onChange={(ev) => setManual(d, f.id, ev.target.value)}
                            />
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "summaryMK" && (
            <div>
              {!hasData && (
                <div className="mk-section-title">
                  Belum ada data diunggah — kolom di bawah menampilkan struktur dengan nilai Rp 0.
                </div>
              )}
              {hasData && (
                <div className="mk-toolbar">
                  <div className="mk-toolbar-range">
                    <label>Dari</label>
                    <input
                      type="date"
                      value={rangeFrom}
                      onChange={(e) => {
                        setRangeFrom(e.target.value);
                        setPage(0);
                      }}
                    />
                    <label>Sampai</label>
                    <input
                      type="date"
                      value={rangeTo}
                      onChange={(e) => {
                        setRangeTo(e.target.value);
                        setPage(0);
                      }}
                    />
                    {(rangeFrom || rangeTo) && (
                      <button
                        className="mk-toolbar-reset"
                        onClick={() => {
                          setRangeFrom("");
                          setRangeTo("");
                          setPage(0);
                        }}
                      >
                        Reset filter
                      </button>
                    )}
                  </div>
                  <div className="mk-toolbar-pager">
                    <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
                      &larr; Sebelumnya
                    </button>
                    <span>
                      {rangeFilteredDates.length === 0
                        ? "Tidak ada tanggal"
                        : `${formatDateLabel(visibleDates[0])} – ${formatDateLabel(visibleDates[visibleDates.length - 1])} · hal ${safePage + 1}/${totalPages}`}
                    </span>
                    <button disabled={safePage >= totalPages - 1} onClick={() => setPage(safePage + 1)}>
                      Berikutnya &rarr;
                    </button>
                  </div>
                </div>
              )}

              <div className="mk-table-wrap">
                <table className="mk-ledger">
                  <thead>
                    <tr>
                      <th>Working Capital Daily Monitoring</th>
                      {visibleDates.map((d) => (
                        <th key={d}>{formatDateLabel(d)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <Row label="Modal Kerja" values={targetMK} dates={visibleDates} band="purple" />

                    <Row label="Saldo Bank" values={elementActual.bank} dates={visibleDates} band="teal" />
                    {bankList.map((bank) => (
                      <Row key={bank} label={"Bank " + bank} values={saldoBankPerBank[bank] || {}} dates={visibleDates} indent />
                    ))}

                    <Row label="Xendit" values={elementActual.xendit} dates={visibleDates} band="teal" />
                    <Row label="Xendit" values={elementActual.xendit} dates={visibleDates} indent />

                    <Row label="Stock" values={stockTotal} dates={visibleDates} band="teal" />
                    <Row label="Physical" values={elementActual.fisik} dates={visibleDates} indent />
                    <Row label="Logical" values={elementActual.logical} dates={visibleDates} indent />
                    <Row label="Digital" values={digitalTotal} dates={visibleDates} indent />
                    <Row label="Attack" values={elementActual.attack} dates={visibleDates} indent />
                    <Row label="Eload" values={elementActual.eload} dates={visibleDates} indent />
                    <Row label="WG Stok" values={elementActual.stockWG} dates={visibleDates} indent />

                    <Row label="Actual Modal Kerja" values={actualMK} dates={visibleDates} band="teal" />

                    <Row label="Modal Kerja Vs Actual MK" values={vsActual} dates={visibleDates} band="yellow" tone="signed" />
                    <Row label="Selisih_Kurang & Selisih_Lebih" values={selisihAbs} dates={visibleDates} band="yellow" />

                    <Row label="Selisih_Kurang" values={selisihKurang} dates={visibleDates} band="yellow" />
                    {KURANG_FIELDS.map((f) => (
                      <Row key={f.id} label={f.label} values={Object.fromEntries(calcDates.map((d) => [d, toNumber((cData.manual[d] || {})[f.id])]))} dates={visibleDates} indent italic />
                    ))}

                    <Row label="Selisih_Lebih" values={selisihLebih} dates={visibleDates} band="yellow" />
                    {LEBIH_FIELDS.map((f) => (
                      <Row key={f.id} label={f.label} values={Object.fromEntries(calcDates.map((d) => [d, toNumber((cData.manual[d] || {})[f.id])]))} dates={visibleDates} indent italic />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mk-section-title">Rekonsiliasi Omset vs Uang Masuk</div>
              <div className="mk-table-wrap">
                <table className="mk-ledger">
                  <thead>
                    <tr>
                      <th>Tanggal</th>
                      {visibleDates.map((d) => (
                        <th key={d}>{formatDateLabel(d)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <Row label="Omset (Order Log)" values={omset} dates={visibleDates} />
                    <Row label="Uang Masuk (Bank + Xendit)" values={uangMasuk} dates={visibleDates} />
                    <Row label="Selisih" values={selisihOmset} dates={visibleDates} band="yellow" tone="signed" />
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "modalKerja" && (
            <div>
              {!hasData && (
                <div className="mk-section-title">
                  Belum ada data diunggah — kolom di bawah menampilkan struktur dengan nilai Rp 0.
                </div>
              )}
              <div className="mk-section-title">
                Modal Kerja {activeCluster} — {cData.opening.bulan || "bulan berjalan"}
              </div>
              <div className="mk-table-wrap">
                <table className="mk-ledger">
                  <thead>
                    <tr className="mk-pct-row">
                      <th>Tgl</th>
                      {MK_SUMMARY_ORDER.map((id) => (
                        <th key={id}>{fmtPct(elementPct[id])}</th>
                      ))}
                      <th></th>
                    </tr>
                    <tr>
                      <th>&nbsp;</th>
                      {MK_SUMMARY_ORDER.map((id) => (
                        <th key={id}>{MK_ELEMENTS.find((e) => e.id === id).label}</th>
                      ))}
                      <th>Actual Modal Kerja</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calcDates.map((d) => (
                      <tr key={d} className="lrow">
                        <td className="lr-label">{formatDateLabel(d)}</td>
                        {MK_SUMMARY_ORDER.map((id) => (
                          <td key={id} className="lr-val">
                            {fmtRp(elementActual[id][d])}
                          </td>
                        ))}
                        <td className="lr-val">{fmtRp(actualMK[d])}</td>
                      </tr>
                    ))}
                    <tr className="mk-grand-total">
                      <td className="lr-label">Grand Total (saldo akhir periode)</td>
                      {MK_SUMMARY_ORDER.map((id) => (
                        <td key={id} className="lr-val">
                          {lastDate ? fmtRp(elementActual[id][lastDate]) : "-"}
                        </td>
                      ))}
                      <td className="lr-val">{lastDate ? fmtRp(actualMK[lastDate]) : "-"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="mk-section-title">
                Persentase di header dihitung dari komposisi Modal Kerja Awal Bulan (tab Unggah Data). Baris Grand
                Total memakai saldo hari terakhir yang datanya tersedia — angka ini yang jadi acuan opening bulan
                berikutnya.
              </div>
            </div>
          )}

          {tab === "riwayat" && (
            <div>
              <div className="mk-section-title">
                Lembar kerja tersimpan otomatis tiap bulan untuk {activeCluster}
              </div>

              {historyLoading && <div className="mk-empty">Memuat riwayat...</div>}

              {!historyLoading && historyKeys.length === 0 && (
                <div className="mk-empty">
                  Belum ada bulan yang tersimpan. Riwayat muncul otomatis setelah lembar kerja bulan berjalan
                  tersimpan (atau setelah "Buat Lembar Kerja Baru" dipakai).
                </div>
              )}

              <div className="mk-history-grid">
                {historyKeys.map((key) => {
                  const period = key.split(":").pop();
                  return (
                    <button
                      key={key}
                      className={"mk-history-item" + (viewingPeriod === key ? " active" : "")}
                      onClick={() => viewPeriod(key)}
                    >
                      {formatMonthLabel(period)}
                      {period === cData.activePeriod ? " (aktif)" : ""}
                    </button>
                  );
                })}
              </div>

              {viewingLoading && <div className="mk-empty">Memuat data bulan terpilih...</div>}

              {!viewingLoading && viewingData && (
                <>
                  {(() => {
                    const s = summarizeCluster(viewingData);
                    return (
                      <>
                        <div className="mk-section-title">
                          Ringkasan {formatMonthLabel(viewingPeriod.split(":").pop())} — {s.dateCount} hari tercatat
                          {s.firstDate ? `, ${formatDateLabel(s.firstDate)} s.d. ${formatDateLabel(s.lastDate)}` : ""}
                        </div>
                        <div className="mk-table-wrap">
                          <table className="mk-ledger">
                            <thead>
                              <tr>
                                <th>Ringkasan Bulan</th>
                                <th>Nilai</th>
                              </tr>
                            </thead>
                            <tbody>
                              <Row label="Modal Kerja Awal" values={{ v: s.openingTotal }} dates={["v"]} band="purple" />
                              <Row label="Actual Modal Kerja (saldo akhir)" values={{ v: s.actualLast }} dates={["v"]} band="teal" />
                              <Row label="Selisih (Actual vs Awal)" values={{ v: s.selisih }} dates={["v"]} band="yellow" tone="signed" />
                              {MK_SUMMARY_ORDER.map((id) => (
                                <Row
                                  key={id}
                                  label={MK_ELEMENTS.find((e) => e.id === id).label}
                                  values={{ v: s.elementsAtClose[id] }}
                                  dates={["v"]}
                                  indent
                                />
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
