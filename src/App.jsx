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

function matchesCluster(row, clusterName) {
  if (!clusterName) return true;
  const rowCluster = String(getField(row, ["Sales Cluster", "sales cluster"])).trim().toLowerCase();
  return rowCluster === String(clusterName).trim().toLowerCase();
}

function parseOrderLog(rows, clusterName) {
  const byDate = {};
  for (const row of rows) {
    if (!matchesCluster(row, clusterName)) continue;
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

function parseOrderLogByCanvasser(rows, clusterName) {
  const map = {};
  for (const row of rows) {
    if (!matchesCluster(row, clusterName)) continue;
    const status = getField(row, ["Status Order", "status order"]);
    if (String(status).trim().toLowerCase() !== "completed") continue;
    const canvasserId = getField(row, ["Canvasser ID", "canvasser id"]);
    const canvasserName = getField(row, ["Canvasser Name", "canvasser name"]);
    if (!canvasserId && !canvasserName) continue;
    const dt = parseAnyDate(getField(row, ["Last Update", "last update"]));
    const productName = getField(row, ["Product Name/Denom", "Product Name", "product name"]) || "-";
    const qty = toNumber(getField(row, ["Total Product", "total product"]));
    const priceSum =
      toNumber(getField(row, ["Product Price"])) +
      toNumber(getField(row, ["Package Price"])) +
      toNumber(getField(row, ["Markup Price"]));
    const total = qty * priceSum;
    const key = (canvasserId || canvasserName) + "|" + productName;
    if (!map[key]) {
      map[key] = {
        canvasserId,
        canvasserName,
        productName,
        lastDate: dt ? dateKey(dt) : "",
        qty: 0,
        total: 0,
      };
    }
    map[key].qty += qty;
    map[key].total += total;
    if (dt) {
      const dStr = dateKey(dt);
      if (!map[key].lastDate || dStr > map[key].lastDate) map[key].lastDate = dStr;
    }
  }
  return map;
}

function aggregateCanvasserSales(orderLogByCanvasser) {
  const detail = [];
  ["physical", "logical", "wg"].forEach((slot) => {
    Object.values(orderLogByCanvasser?.[slot] || {}).forEach((item) => detail.push(item));
  });
  const summaryMap = {};
  detail.forEach((item) => {
    const key = item.canvasserId || item.canvasserName;
    if (!summaryMap[key]) {
      summaryMap[key] = { canvasserId: item.canvasserId, canvasserName: item.canvasserName, totalSales: 0 };
    }
    summaryMap[key].totalSales += item.total;
  });
  const summary = Object.values(summaryMap).sort((a, b) => b.totalSales - a.totalSales);
  const detailSorted = [...detail].sort(
    (a, b) => (a.canvasserName || "").localeCompare(b.canvasserName || "") || (a.productName || "").localeCompare(b.productName || "")
  );
  return { summary, detail: detailSorted };
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
  ADJUSTMENT_FIELDS.forEach((f) => (o[f.id] = ""));
  return o;
}

function computeOpeningTotal(opening) {
  const base = MK_ELEMENTS.reduce((s, e) => s + toNumber(opening?.[e.id]), 0);
  const kurang = KURANG_FIELDS.reduce((s, f) => s + toNumber(opening?.[f.id]), 0);
  const lebih = LEBIH_FIELDS.reduce((s, f) => s + toNumber(opening?.[f.id]), 0);
  return base - kurang + lebih;
}

function emptyCluster() {
  return {
    orderLog: { physical: {}, logical: {}, wg: {} },
    orderLogByCanvasser: { physical: {}, logical: {}, wg: {} },
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
  const openingTotal = computeOpeningTotal(c.opening);
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

function ManualDateForm({ fields, allDates, manualData, onSave }) {
  function draftFor(d) {
    const base = manualData[d] || {};
    const out = {};
    fields.forEach((f) => (out[f.id] = base[f.id] ?? ""));
    return out;
  }

  const [date, setDate] = useState(allDates[0] || "");
  const [draft, setDraft] = useState(() => draftFor(allDates[0] || ""));
  const [savedMsg, setSavedMsg] = useState("");

  useEffect(() => {
    if (allDates.length > 0 && !allDates.includes(date)) {
      setDate(allDates[0]);
      setDraft(draftFor(allDates[0]));
      setSavedMsg("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDates.join(",")]);

  if (allDates.length === 0) return null;

  function handleDateChange(newDate) {
    setDate(newDate);
    setDraft(draftFor(newDate));
    setSavedMsg("");
  }

  function handleSave() {
    onSave(date, draft);
    setSavedMsg("Tersimpan ke " + formatDateLabel(date));
  }

  return (
    <div className="mk-single-form">
      <div className="mk-single-form-head">
        <label>Tanggal</label>
        <select value={date} onChange={(e) => handleDateChange(e.target.value)}>
          {allDates.map((d) => (
            <option key={d} value={d}>
              {formatDateLabel(d)}
            </option>
          ))}
        </select>
        <button className="mk-single-save" onClick={handleSave}>
          Simpan
        </button>
        {savedMsg && <span className="mk-single-saved-msg">{savedMsg}</span>}
      </div>
      <div className="mk-single-form-grid">
        {fields.map((f) => (
          <div className="mk-manual-field" key={f.id}>
            <label>{f.label}</label>
            <input
              type="number"
              value={draft[f.id] ?? ""}
              onChange={(e) => setDraft((prev) => ({ ...prev, [f.id]: e.target.value }))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- main component ----------


export default function ModalKerjaPrototype() {
  const [clusters, setClusters] = useState([]);
  const [activeCluster, setActiveCluster] = useState(null);
  const [newCluster, setNewCluster] = useState("");
  const [tab, setTab] = useState("upload");

  const [store, setStore] = useState({});

  // load the list of cluster names from Supabase on first load, so
  // refreshing the page doesn't lose track of clusters that were created
  // (and whose data is already saved) in an earlier session.
  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get("_clusters", false);
        const list = JSON.parse(res.value);
        if (Array.isArray(list) && list.length > 0) {
          setClusters(list);
          setActiveCluster((prev) => prev || list[0]);
          return;
        }
      } catch (err) {
        // belum ada daftar cluster tersimpan — coba tebak dari data lama di bawah
      }
      // fallback: rekonstruksi daftar cluster dari key data "mk:<cluster>:<periode>"
      // yang sudah tersimpan sebelum daftar cluster ini ada (data lama).
      try {
        const res2 = await storage.list("mk:", false);
        const keys = res2?.keys || [];
        const names = Array.from(new Set(keys.map((k) => k.split(":")[1]).filter(Boolean)));
        if (names.length > 0) {
          setClusters(names);
          setActiveCluster((prev) => prev || names[0]);
          storage.set("_clusters", JSON.stringify(names), false).catch(() => {});
        }
      } catch (err) {
        // tidak ada data tersimpan sama sekali — mulai kosong
      }
    })();
  }, []);

  const [newBankName, setNewBankName] = useState("");
  const [bankNames, setBankNames] = useState(["BCA", "BRI"]);

  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 4;

  const [dismissedMonths, setDismissedMonths] = useState([]);

  const [openingDraft, setOpeningDraft] = useState(store[activeCluster]?.opening || emptyOpening());
  const [openingSavedMsg, setOpeningSavedMsg] = useState("");
  useEffect(() => {
    setOpeningDraft(store[activeCluster]?.opening || emptyOpening());
    setOpeningSavedMsg("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCluster]);

  function setDraftField(field, value) {
    setOpeningDraft((prev) => ({ ...prev, [field]: value }));
    setOpeningSavedMsg("");
  }

  const openingDraftTotal = computeOpeningTotal(openingDraft);
  const openingDraftKurang = KURANG_FIELDS.reduce((s, f) => s + toNumber(openingDraft[f.id]), 0);
  const openingDraftLebih = LEBIH_FIELDS.reduce((s, f) => s + toNumber(openingDraft[f.id]), 0);

  async function handleSaveOpening() {
    const period = cData.activePeriod || monthKey(dateKey(new Date()));
    const newCData = { ...cData, opening: { ...openingDraft }, activePeriod: period };
    updateCluster(() => newCData);
    setOpeningSavedMsg("Menyimpan...");
    try {
      const key = "mk:" + activeCluster + ":" + period;
      await storage.set(key, JSON.stringify(newCData), false);
      setOpeningSavedMsg("Tersimpan · " + new Date().toLocaleTimeString("id-ID"));
    } catch (err) {
      setOpeningSavedMsg("Gagal menyimpan");
    }
  }

  const [uploadSavedMsg, setUploadSavedMsg] = useState("");
  async function handleSaveWorksheet() {
    const period = cData.activePeriod || monthKey(dateKey(new Date()));
    const newCData = { ...cData, activePeriod: period };
    updateCluster(() => newCData);
    setUploadSavedMsg("Menyimpan...");
    try {
      const key = "mk:" + activeCluster + ":" + period;
      await storage.set(key, JSON.stringify(newCData), false);
      setUploadSavedMsg("Tersimpan ke Supabase · " + new Date().toLocaleTimeString("id-ID"));
    } catch (err) {
      setUploadSavedMsg("Gagal menyimpan");
    }
  }
  const [saveStatus, setSaveStatus] = useState("");
  const [historyKeys, setHistoryKeys] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [viewingPeriod, setViewingPeriod] = useState(null);
  const [viewingData, setViewingData] = useState(null);
  const [viewingLoading, setViewingLoading] = useState(false);

  const cData = store[activeCluster] || emptyCluster();

  function updateCluster(fn) {
    setStore((prev) => ({ ...prev, [activeCluster]: fn(prev[activeCluster]) }));
  }

  function handleOrderLogFile(slotId, file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const byDate = parseOrderLog(res.data, activeCluster);
        const byCanvasser = parseOrderLogByCanvasser(res.data, activeCluster);
        const matchedCount = Object.values(byDate).length > 0 || Object.keys(byCanvasser).length > 0;
        updateCluster((c) => ({
          ...c,
          orderLog: { ...c.orderLog, [slotId]: byDate },
          orderLogByCanvasser: { ...c.orderLogByCanvasser, [slotId]: byCanvasser },
          orderLogFiles: { ...c.orderLogFiles, [slotId]: { name: file.name, rows: res.data.length } },
        }));
        if (!matchedCount && res.data.length > 0) {
          setUploadSavedMsg(
            'Tidak ada baris dengan kolom "Sales Cluster" = "' +
              activeCluster +
              '" di file ini — cek apakah file-nya untuk cluster yang benar.'
          );
        }
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

  function saveManualFields(dateKeyStr, fieldsObj) {
    updateCluster((c) => ({
      ...c,
      manual: { ...c.manual, [dateKeyStr]: { ...(c.manual[dateKeyStr] || {}), ...fieldsObj } },
    }));
  }

  function setOpening(field, value) {
    updateCluster((c) => ({ ...c, opening: { ...c.opening, [field]: value } }));
  }

  const openingTotal = computeOpeningTotal(cData.opening);

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

  // restore this cluster's most recent saved worksheet from Supabase on
  // first load / cluster switch, if there's nothing local yet — otherwise
  // every page refresh looks "empty" even though data was saved.
  const [restoreDone, setRestoreDone] = useState({});
  useEffect(() => {
    if (!activeCluster) return;
    if (restoreDone[activeCluster]) return;
    const isEmpty =
      Object.keys(cData.orderLogFiles).length === 0 &&
      Object.keys(cData.banks).length === 0 &&
      !cData.xendit.fileName &&
      Object.keys(cData.manual).length === 0;
    if (!isEmpty) {
      setRestoreDone((prev) => ({ ...prev, [activeCluster]: true }));
      return;
    }
    (async () => {
      try {
        const res = await storage.list("mk:" + activeCluster + ":", false);
        const keys = res?.keys || [];
        if (keys.length > 0) {
          const latest = keys.slice().sort().pop();
          const got = await storage.get("mk:" + activeCluster + ":" + latest, false);
          const parsed = JSON.parse(got.value);
          updateCluster(() => parsed);
          setOpeningDraft(parsed.opening || emptyOpening());
          setSaveStatus("Data dimuat dari Supabase (" + formatMonthLabel(latest) + ")");
        }
      } catch (err) {
        // belum ada data tersimpan untuk cluster ini — biarkan kosong
      }
      setRestoreDone((prev) => ({ ...prev, [activeCluster]: true }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCluster]);

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

  async function openPeriodForEditing(key) {
    try {
      const res = await storage.get(key, false);
      const parsed = res ? JSON.parse(res.value) : null;
      if (!parsed) return;
      const period = key.split(":").pop();
      updateCluster(() => ({ ...parsed, activePeriod: period }));
      setOpeningDraft(parsed.opening || emptyOpening());
      setSaveStatus("Lembar kerja " + formatMonthLabel(period) + " dibuka untuk diedit");
      setTab("summaryMK");
    } catch (err) {
      setSaveStatus("Gagal membuka lembar kerja bulan tersebut");
    }
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
  const canvasserSales = aggregateCanvasserSales(cData.orderLogByCanvasser);

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
          max-width: 100vw;
          overflow-x: hidden;
        }
        .mk-shell { display: grid; grid-template-columns: 220px minmax(0, 1fr); min-height: 100%; max-width: 100vw; overflow-x: hidden; }
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

        .mk-main { padding: 28px 36px 60px; min-width: 0; max-width: 100%; overflow-x: hidden; }
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
        .mk-opening-subhead { font-size: 12px; color: #524646; font-weight: 600; margin: 18px 0 8px; padding-top: 12px; border-top: 1px dashed var(--rule-soft); }
        .mk-opening-subhead span { font-weight: 400; color: var(--ink-text-dim); font-size: 11px; }
        .mk-opening-subtotal { margin-top: 8px; display: flex; justify-content: space-between; font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: var(--ink-text-dim); }
        .mk-opening-save-row { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--rule-soft); display: flex; align-items: center; gap: 12px; }
        .mk-upload-save-hint { font-size: 11.5px; color: var(--ink-text-dim); line-height: 1.5; margin: 8px 0 26px; max-width: 640px; }
        .mk-status-badge { display: inline-block; padding: 2px 9px; border-radius: 3px; font-size: 11px; font-weight: 600; font-family: 'Inter', sans-serif; }
        .mk-status-lunas { background: var(--band-a); color: #524646; }
        .mk-status-lebih-setor { background: var(--slate); color: #524646; }
        .mk-status-kurang-setor { background: var(--band-c); color: #fcf2e5; }

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
        .mk-empty-cluster { padding: 40px 4px; }
        .mk-empty-cluster .mk-sub { margin-top: 8px; margin-bottom: 0; max-width: 480px; }

        .mk-single-form { background: var(--paper); border: 1px solid var(--rule-soft); border-radius: 4px; padding: 16px 18px; margin-bottom: 10px; }
        .mk-single-form-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px dashed var(--rule-soft); }
        .mk-single-form-head label { font-size: 12px; color: #524646; }
        .mk-single-form-head select { background: var(--paper-2); border: 1px solid var(--rule-soft); color: #524646; font-family: 'IBM Plex Mono', monospace; font-size: 13px; padding: 6px 8px; border-radius: 3px; }
        .mk-single-save { background: var(--accent); color: #fcf2e5; border: none; padding: 7px 16px; border-radius: 3px; font-size: 13px; font-weight: 600; cursor: pointer; }
        .mk-single-save:hover { background: var(--accent-deep); }
        .mk-single-saved-msg { font-size: 12px; color: var(--slate); font-style: italic; }
        .mk-single-form-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }

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
                  const nextList = [...clusters, name];
                  setClusters(nextList);
                  setStore((prev) => ({ ...prev, [name]: emptyCluster() }));
                  setActiveCluster(name);
                  setNewCluster("");
                  storage.set("_clusters", JSON.stringify(nextList), false).catch(() => {});
                }}
              >
                +
              </button>
            </div>
          </div>
        </aside>

        <main className="mk-main">
          {!activeCluster ? (
            <div className="mk-empty-cluster">
              <div className="mk-h1">Belum ada cluster</div>
              <div className="mk-sub">
                Tambahkan cluster pertama lewat kolom "Tambah cluster..." di sidebar kiri untuk mulai input data.
              </div>
            </div>
          ) : (
            <>
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
            <button className={"mk-tab" + (tab === "rekapSales" ? " active" : "")} onClick={() => setTab("rekapSales")}>
              Rekap Sales
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
                    value={openingDraft.bulan}
                    onChange={(e) => setDraftField("bulan", e.target.value)}
                  />
                </div>
                <div className="mk-opening-grid">
                  {MK_ELEMENTS.map((e) => (
                    <div className="mk-opening-field" key={e.id}>
                      <label>{e.label}</label>
                      <input
                        type="number"
                        placeholder="0"
                        value={openingDraft[e.id]}
                        onChange={(ev) => setDraftField(e.id, ev.target.value)}
                      />
                    </div>
                  ))}
                </div>

                <div className="mk-opening-subhead">
                  Selisih Kurang <span>(mengurangi Modal Kerja Awal)</span>
                </div>
                <div className="mk-opening-grid">
                  {KURANG_FIELDS.map((f) => (
                    <div className="mk-opening-field" key={f.id}>
                      <label>{f.label}</label>
                      <input
                        type="number"
                        placeholder="0"
                        value={openingDraft[f.id]}
                        onChange={(ev) => setDraftField(f.id, ev.target.value)}
                      />
                    </div>
                  ))}
                </div>
                <div className="mk-opening-subtotal">
                  <span>Total Selisih Kurang</span>
                  <span>- {fmtRp(openingDraftKurang)}</span>
                </div>

                <div className="mk-opening-subhead">
                  Selisih Lebih <span>(menambah Modal Kerja Awal)</span>
                </div>
                <div className="mk-opening-grid">
                  {LEBIH_FIELDS.map((f) => (
                    <div className="mk-opening-field" key={f.id}>
                      <label>{f.label}</label>
                      <input
                        type="number"
                        placeholder="0"
                        value={openingDraft[f.id]}
                        onChange={(ev) => setDraftField(f.id, ev.target.value)}
                      />
                    </div>
                  ))}
                </div>
                <div className="mk-opening-subtotal">
                  <span>Total Selisih Lebih</span>
                  <span>+ {fmtRp(openingDraftLebih)}</span>
                </div>

                <div className="mk-opening-total">
                  <span>Total Modal Kerja Awal (setelah Selisih Kurang/Lebih)</span>
                  <span>{fmtRp(openingDraftTotal)}</span>
                </div>

                <div className="mk-opening-save-row">
                  <button className="mk-single-save" onClick={handleSaveOpening}>
                    Simpan Modal Kerja Awal
                  </button>
                  {openingSavedMsg && <span className="mk-single-saved-msg">{openingSavedMsg}</span>}
                </div>
              </div>

              {allDates.length > 0 && (
                <>
                  <div className="mk-section-title">Selisih_Kurang &amp; Selisih_Lebih</div>
                  <ManualDateForm
                    fields={[...KURANG_FIELDS, ...LEBIH_FIELDS]}
                    allDates={allDates}
                    manualData={cData.manual}
                    onSave={(date, draft) => saveManualFields(date, draft)}
                  />
                </>
              )}

              <div className="mk-section-title">Order Log</div>
              <div className="mk-upload-save-hint">
                Otomatis difilter berdasarkan kolom "Sales Cluster" di file — hanya baris dengan Sales Cluster =
                "{activeCluster}" yang dihitung, walau file-nya berisi banyak cluster sekaligus.
              </div>
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

              <div className="mk-opening-save-row">
                <button className="mk-single-save" onClick={handleSaveWorksheet}>
                  Simpan Data Upload Hari Ini
                </button>
                {uploadSavedMsg && <span className="mk-single-saved-msg">{uploadSavedMsg}</span>}
              </div>
              <div className="mk-upload-save-hint">
                Setiap upload (Order Log, Mutasi Bank, Xendit) langsung menggantikan data lama di kartu yang sama —
                kalau upload sore lebih lengkap dari pagi, tinggal upload ulang lalu klik Simpan di sini, tidak
                perlu ulang dari awal. Khusus Detail Daily Settlement, tiap upload digabung per tanggal (bukan
                menimpa), jadi aman upload beda tanggal secara terpisah.
              </div>

              {allDates.length > 0 && (
                <>
                  <div className="mk-section-title">Input Manual — Stock &amp; Digital</div>
                  <ManualDateForm
                    fields={MANUAL_ELEMENTS}
                    allDates={allDates}
                    manualData={cData.manual}
                    onSave={(date, draft) => saveManualFields(date, draft)}
                  />
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
              {!hasData && openingTotal === 0 && (
                <div className="mk-section-title">
                  Belum ada Modal Kerja Awal maupun data harian — kolom di bawah menampilkan struktur dengan nilai
                  Rp 0.
                </div>
              )}
              {!hasData && openingTotal !== 0 && (
                <div className="mk-section-title">
                  Modal Kerja Awal sudah tersimpan (baris pertama di bawah). Kolom tanggal harian masih Rp 0 karena
                  belum ada Order Log / Mutasi Bank / Xendit yang diunggah.
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
                    <tr className="lrow band-purple">
                      <td className="lr-label">
                        Modal Kerja Awal ({cData.opening.bulan || "bulan berjalan"})
                      </td>
                      {MK_SUMMARY_ORDER.map((id) => (
                        <td key={id} className="lr-val">
                          {fmtRp(toNumber(cData.opening[id]))}
                        </td>
                      ))}
                      <td className="lr-val">{fmtRp(openingTotal)}</td>
                    </tr>
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

          {tab === "rekapSales" && (
            <div>
              {canvasserSales.summary.length === 0 ? (
                <div className="mk-empty">
                  Belum ada data. Rekap ini otomatis dari Order Log (Physical/Logical/WG) — hanya baris dengan
                  Status Order "Completed" yang dihitung, dikelompokkan per Canvasser Name.
                </div>
              ) : (
                <>
                  <div className="mk-section-title">
                    Rekap Penjualan per Sales — dari Order Log (Status Order: Completed), semua tanggal yang
                    diunggah
                  </div>
                  <div className="mk-upload-save-hint">
                    Total penjualan = Total Product (qty) × (Product Price + Package Price + Markup Price), tanggal
                    diambil dari kolom Last Update. Rekonsiliasi uang masuk vs omset tetap dilihat di level
                    keseluruhan cluster pada tab Summary MK (Rekonsiliasi Omset vs Uang Masuk) — Mutasi Bank & Xendit
                    tidak mencatat per-sales.
                  </div>
                  <div className="mk-table-wrap">
                    <table className="mk-ledger">
                      <thead>
                        <tr>
                          <th>Canvasser ID</th>
                          <th>Nama Sales</th>
                          <th>Total Penjualan</th>
                        </tr>
                      </thead>
                      <tbody>
                        {canvasserSales.summary.map((s) => (
                          <tr key={s.canvasserId + "|" + s.canvasserName} className="lrow">
                            <td className="lr-label">{s.canvasserId}</td>
                            <td className="lr-val" style={{ textAlign: "left" }}>
                              {s.canvasserName}
                            </td>
                            <td className="lr-val">{fmtRp(s.totalSales)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="mk-section-title">Detail per Sales per Produk</div>
                  <div className="mk-table-wrap">
                    <table className="mk-ledger">
                      <thead>
                        <tr>
                          <th>Nama Sales</th>
                          <th>Nama Produk</th>
                          <th>Tanggal Terakhir</th>
                          <th>Qty (Total Product)</th>
                          <th>Harga Barang</th>
                          <th>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {canvasserSales.detail.map((d, i) => (
                          <tr key={i} className="lrow">
                            <td className="lr-label" style={{ textAlign: "left" }}>
                              {d.canvasserName}
                            </td>
                            <td className="lr-val" style={{ textAlign: "left" }}>
                              {d.productName}
                            </td>
                            <td className="lr-val">{d.lastDate ? formatDateLabel(d.lastDate) : "-"}</td>
                            <td className="lr-val">{d.qty.toLocaleString("id-ID")}</td>
                            <td className="lr-val">{fmtRp(d.qty > 0 ? d.total / d.qty : 0)}</td>
                            <td className="lr-val">{fmtRp(d.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
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
                        <div className="mk-opening-save-row">
                          <button
                            className="mk-single-save"
                            onClick={() => openPeriodForEditing(viewingPeriod)}
                          >
                            Buka &amp; Edit Bulan Ini
                          </button>
                          <span className="mk-single-saved-msg">
                            Setelah dibuka, tab Summary MK dan Modal Kerja akan menampilkan bulan ini, dan kamu bisa
                            unggah/edit data tambahan untuk bulan ini di tab Unggah Data.
                          </span>
                        </div>
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
