import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { UserButton, useUser, useAuth } from "@clerk/clerk-react";
import {
  PenTool,
  Download,
  RefreshCw,
  Trash2,
  Languages,
  PenLine,
  FileText,
  Info,
  Eye,
  Clipboard,
  Check,
  ArrowLeft,
  ArrowRight,
  ShieldCheck,
  SplitSquareVertical,
  Layers,
  CheckCircle2,
  Crown,
  CreditCard,
  X,
} from "lucide-react";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { jsPDF } from "jspdf";
import { RichTextEditor } from "../components/RichTextEditor";
import { transformText, TransformationResult } from "../services/geminiService";
import { createBillingPortal, createCheckout, getUserTier, limitForTier, FREE_RUN_LIMIT, FREE_WORD_LIMIT, UserTierInfo } from "../services/api";
import { looksNonEnglish, ENGLISH_ONLY_MESSAGE } from "../lib/language";

const DIALECTS = [
  { value: "auto", label: "Auto-Detect" },
  { value: "US", label: "American" },
  { value: "UK", label: "British" },
  { value: "CA", label: "Canadian" },
  { value: "AU", label: "Australian" },
];

const DOMAINS = [
  { value: "academic", label: "Academic" },
  { value: "business", label: "Business" },
  { value: "creative", label: "Literary" },
  { value: "general", label: "General" },
];

const TONES = [
  { value: "neutral", label: "Neutral" },
  { value: "formal", label: "Formal" },
  { value: "informal", label: "Informal" },
  { value: "persuasive", label: "Persuasive" },
  { value: "empathetic", label: "Empathetic" },
];

// Word-level diff (LCS) so "what changed" is visible even for subtle edits.
// Comparison uses an apostrophe/punctuation-agnostic key (curly "SPPAIS’s" and
// straight "SPPAIS's" are the same word) but renders the original tokens, so a
// glyph-style flip never shows up as an add+delete pair.
type WordDiffPart = { text: string; type: "same" | "add" | "del" };
const normWordKey = (w: string): string =>
  w.replace(/[\u2018\u2019]/g, "'").toLowerCase().replace(/[^a-z]/g, "");
const wordDiff = (a: string, b: string): WordDiffPart[] => {
  const aa = a.split(/\s+/).filter(Boolean);
  const bb = b.split(/\s+/).filter(Boolean);
  const ka = aa.map(normWordKey);
  const kb = bb.map(normWordKey);
  const n = aa.length;
  const m = bb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const parts: WordDiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { parts.push({ text: aa[i], type: "same" }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { parts.push({ text: aa[i], type: "del" }); i++; }
    else { parts.push({ text: bb[j], type: "add" }); j++; }
  }
  while (i < n) { parts.push({ text: aa[i], type: "del" }); i++; }
  while (j < m) { parts.push({ text: bb[j], type: "add" }); j++; }
  return parts;
};

const DiffSpans = ({ orig, rev }: { orig: string; rev: string }) => {
  const parts = wordDiff(orig, rev);
  return (
    <>
      {parts.map((p, i) =>
        p.type === "del" ? (
          <span key={i} className="text-rose-300 line-through decoration-rose-500/80">
            {p.text}{" "}
          </span>
        ) : p.type === "add" ? (
          <span key={i} className="text-emerald-200 bg-emerald-500/20 px-0.5 rounded">
            {p.text}{" "}
          </span>
        ) : (
          <span key={i}>{p.text} </span>
        )
      )}
    </>
  );
};

const PRESETS = [
  {
    name: "Academic",
    domain: "academic",
    dialect: "US",
    tone: "formal",
    html: "<p>Despite of the difficulties, the research team went ahead with the methodology [1]. I mean, they probably had to, because the stakeholders wanted to find some sort of positive result. Maybe they are right, who knows. Let us analyze this.</p>",
  },
  {
    name: "Business",
    domain: "business",
    dialect: "US",
    tone: "empathetic",
    html: "<p>We are writing this email to tell you that there is a possibility that we might not be able to finish the project on the agreed date because of supplier problems. We want to discuss with you about the cost of our services because the workload became very bigger than what was originally written inside our contract agreement.</p>",
  },
  {
    name: "Literary",
    domain: "creative",
    dialect: "UK",
    tone: "neutral",
    html: "<p>The city was waking up slowly when the sun was coming up behind the grey buildings of the harbor and the gulls were shouting loud. The rain was falling heavily on the old house and made a loud sound on the tin roof while the wind blew hard outside.</p>",
  },
  {
    name: "General",
    domain: "general",
    dialect: "US",
    tone: "persuasive",
    html: "<p>Ever since I was a child I always had an enormous passion for discovering computers and doing programming algorithms to fix problems. I am writing in order to express my wish to participate in your esteemed organization as an intern during this summer vacation.</p>",
  },
];

export default function ToolPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { getToken } = useAuth();
  const { user } = useUser();
  const [inputHtml, setInputHtml] = useState<string>(PRESETS[0].html);
  const [forcedDialect, setForcedDialect] = useState<string>(() => {
    try {
      return localStorage.getItem("idiomoptima.dialect") || "auto";
    } catch {
      return "auto";
    }
  });
  const [domain, setDomain] = useState<string>("academic");
  const [tone, setTone] = useState<string>("neutral");

  const [loading, setLoading] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [progressPhase, setProgressPhase] = useState<string>("");
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const elapsedTimerRef = useRef<number | null>(null);
  const [result, setResult] = useState<TransformationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [languageNotice, setLanguageNotice] = useState<string | null>(null);
  const [tierInfo, setTierInfo] = useState<UserTierInfo | null>(null);
  const [limitPanel, setLimitPanel] = useState<"runs" | "words" | null>(null);
  const [upgradeLoading, setUpgradeLoading] = useState<boolean>(false);
  const [portalLoading, setPortalLoading] = useState<boolean>(false);
  const [banner, setBanner] = useState<string | null>(null);

  const [selectedSentenceIdx, setSelectedSentenceIdx] = useState<number | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [outputViewMode, setOutputViewMode] = useState<"fulltext" | "diff" | "notes">("fulltext");
  // Hover + editing state for the unified output panel.
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [overrides, setOverrides] = useState<Record<number, string>>({});

  const [idiomDatabase, setIdiomDatabase] = useState<any[]>([]);
  const [aiPhraseMap, setAiPhraseMap] = useState<any[]>([]);
  const [lexicalDatabases, setLexicalDatabases] = useState<Record<string, any[]>>({});
  const databasesRef = useRef<{ idiomDatabase: any[]; aiPhraseMap: any[]; lexicalDatabases: Record<string, any[]> } | null>(null);

  const loadDatabases = useCallback(async () => {
    if (databasesRef.current) return databasesRef.current;
    const idiomDatabaseNext: any[] = [];
    try {
      const idiomRes = await fetch("/idioms-clunky-native.json");
      if (idiomRes.ok) idiomDatabaseNext.push(...(await idiomRes.json()));
    } catch {}

    let aiPhraseMapNext: any[] = [];
    try {
      const [db1, db2, db3] = await Promise.all([
        fetch("/ai-natural-database.json").then((r) => (r.ok ? r.json() : [])),
        fetch("/ai-natural-database-1500.json").then((r) => (r.ok ? r.json() : [])),
        fetch("/ai-natural-database-1000.json").then((r) => (r.ok ? r.json() : [])),
      ]);
      const merged = new Map<string, any>();
      for (const db of [db1, db2, db3]) {
        for (const entry of db) {
          const key = (entry.ai || entry.clunky || "").toLowerCase().trim();
          if (key && (entry.natural || entry.native)) {
            const existing = merged.get(key);
            if (!existing || JSON.stringify(entry).length > JSON.stringify(existing).length) {
              merged.set(key, entry);
            }
          }
        }
      }
      aiPhraseMapNext = Array.from(merged.values());
    } catch {}

    const lexicalDatabasesNext: Record<string, any[]> = {};
    try {
      for (const d of ["academic", "business", "creative", "general"]) {
        const res = await fetch(`/lexical-${d}.json`);
        if (res.ok) lexicalDatabasesNext[d] = await res.json();
      }
    } catch {}

    const dbs = { idiomDatabase: idiomDatabaseNext, aiPhraseMap: aiPhraseMapNext, lexicalDatabases: lexicalDatabasesNext };
    databasesRef.current = dbs;
    setIdiomDatabase(dbs.idiomDatabase);
    setAiPhraseMap(dbs.aiPhraseMap);
    setLexicalDatabases(dbs.lexicalDatabases);
    return dbs;
  }, []);

  // Backstop: any DB a caller relies on is guaranteed loaded before a transform
  // fires, so a request never goes out with empty maps (which silently disabled
  // the deterministic nativization layer).
  const ensureDatabases = useCallback(async () => {
    return loadDatabases();
  }, [loadDatabases]);

  useEffect(() => {
    loadDatabases();
  }, [loadDatabases]);

  useEffect(() => () => {
    if (elapsedTimerRef.current) {
      window.clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
  }, []);

  const refreshTier = useCallback(async () => {
    try {
      const token = await getToken();
      const info = await getUserTier(token || undefined);
      if (info) setTierInfo(info);
    } catch {}
  }, [getToken]);

  useEffect(() => {
    void refreshTier();
    const upgraded = searchParams.get("upgraded");
    const cancelled = searchParams.get("upgrade_cancelled");
    if (upgraded === "1") {
      setBanner("Payment successful — your account is now on Pro. Enjoy unlimited runs!");
      setTierInfo((t) => (t ? { ...t, tier: "pro", limit: 9999 } : { tier: "pro", usage: 0, limit: 9999 }));
      setSearchParams({}, { replace: true });
    } else if (cancelled === "1") {
      setBanner("Upgrade cancelled — no charges were made. You can upgrade anytime.");
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startUpgrade = async () => {
    if (upgradeLoading) return;
    setUpgradeLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const url = await createCheckout(token, user?.primaryEmailAddress?.emailAddress || undefined);
      if (url) window.location.href = url;
      else setError("Could not start checkout. Please try again.");
    } finally {
      setUpgradeLoading(false);
    }
  };

  const startManage = async () => {
    if (portalLoading) return;
    setPortalLoading(true);
    try {
      const token = await getToken();
      if (!token) return;
      const url = await createBillingPortal(token);
      if (url) window.location.href = url;
      else setError("Could not open billing settings. Please try again.");
    } finally {
      setPortalLoading(false);
    }
  };

  const runLimit = tierInfo ? limitForTier(tierInfo.tier) : FREE_RUN_LIMIT;
  const runsLeft = tierInfo ? Math.max(0, runLimit - tierInfo.usage) : 0;

  const handleTransform = async () => {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = inputHtml;
    // Preserve paragraph breaks from HTML — textContent alone loses them
    const blocks = tempDiv.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, div');
    let plainText: string;
    if (blocks.length > 0) {
      plainText = Array.from(blocks).map(el => (el.textContent || '').trim()).filter(Boolean).join('\n\n');
    } else {
      plainText = tempDiv.textContent || tempDiv.innerText || "";
    }
    // Fallback for stray line breaks
    if (!plainText.includes('\n') && tempDiv.innerText && tempDiv.innerText.includes('\n')) {
      plainText = tempDiv.innerText;
    }
    if (!plainText.trim()) {
      setError("Please write or paste some text into the editor first.");
      return;
    }
    if (tierInfo && tierInfo.tier === "free" && tierInfo.usage >= runLimit) {
      setLimitPanel("runs");
      setError(null);
      return;
    }
    if (tierInfo && tierInfo.tier === "free" && wordCount(plainTextInput) > FREE_WORD_LIMIT) {
      setLimitPanel("words");
      setError(null);
      return;
    }
    if (looksNonEnglish(plainText)) {
      setLanguageNotice(ENGLISH_ONLY_MESSAGE);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    setLanguageNotice(null);
    setResult(null);
    setSelectedSentenceIdx(null);
    setProgress(0);
    setProgressPhase("Analyzing sentence cadence & register markers...");
    setElapsedSec(0);
    if (elapsedTimerRef.current) window.clearInterval(elapsedTimerRef.current);
    elapsedTimerRef.current = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
    try {
      const token = await getToken();
      // Never transform with empty DB maps: block on the load so the worker's
      // deterministic nativization layer always receives the phrase rules.
      const dbs = await ensureDatabases();
      const response = await transformText(
        plainText,
        domain,
        tone,
        forcedDialect === "auto" ? undefined : forcedDialect,
        (percent, _c, _t, phase) => {
          setProgress(percent);
          if (phase) setProgressPhase(phase);
        },
        "auto",
        { idiomDatabase: dbs.idiomDatabase, aiPhraseMap: dbs.aiPhraseMap, lexicalDatabases: dbs.lexicalDatabases },
        token || undefined
      );
      setResult(response);
      setSelectedSentenceIdx(0);
      if (response.tier) {
        setTierInfo({
          tier: response.tier as UserTierInfo["tier"],
          usage: typeof response.usage === "number" ? response.usage : (tierInfo?.usage ?? 0),
          limit: limitForTier(response.tier),
        });
      }
    } catch (err: any) {
      if (err && err.limitReached) {
        setLimitPanel("runs");
        setError(null);
        if (typeof err.usage === "number") {
          setTierInfo((t) => ({ tier: "free", usage: err.usage, limit: t?.limit ?? FREE_RUN_LIMIT }));
        }
      } else if (err && err.wordLimitReached) {
        setLimitPanel("words");
        setError(null);
        if (typeof err.usage === "number") {
          setTierInfo((t) => ({ tier: "free", usage: err.usage, limit: t?.limit ?? FREE_RUN_LIMIT }));
        }
      } else if (err && err.notEnglish) {
        setLanguageNotice(ENGLISH_ONLY_MESSAGE);
        setError(null);
      } else {
        setError(err.message || "Something went wrong during transformation.");
      }
    } finally {
      if (elapsedTimerRef.current) {
        window.clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      setLoading(false);
    }
  };

  const handleClear = () => {
    setInputHtml("<p></p>");
    setResult(null);
    setSelectedSentenceIdx(null);
    setError(null);
    setLanguageNotice(null);
  };

  const loadPreset = (preset: (typeof PRESETS)[0]) => {
    setInputHtml(preset.html);
    setDomain(preset.domain);
    setForcedDialect(preset.dialect);
    setTone(preset.tone);
    setResult(null);
    setSelectedSentenceIdx(null);
    setError(null);
    setLanguageNotice(null);
  };

  const handleCopyFullText = () => {
    if (!result) return;
    navigator.clipboard.writeText(result.finalVersion);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleApplyToEditor = () => {
    if (!result) return;
    setInputHtml(`<p>${result.sentences.map((_, i) => effectiveRevised(i)).join(" ")}</p>`);
  };

  // Effective text for a sentence: an applied override (revert or user edit)
  // wins over the model's revised text.
  const effectiveRevised = (i: number) => {
    const base = overrides[i] ?? result?.sentences[i]?.revised ?? "";
    return base;
  };
  const applyOverride = (i: number, text: string) => {
    setOverrides((prev) => {
      const isSame = result && text.trim() === result.sentences[i]?.revised.trim();
      const next = { ...prev };
      if (isSame) delete next[i];
      else next[i] = text;
      return next;
    });
  };

  const exportAsWord = async () => {
    if (!result) return;
    try {
      const paragraphs = result.sentences.map(
        (s) => new Paragraph({ children: [new TextRun({ text: s.revised + " ", font: "Georgia", size: 24 })] })
      );
      const doc = new Document({
        sections: [
          {
            properties: {},
            children: [
              new Paragraph({
                children: [new TextRun({ text: `IdiomOptima - ${domain.toUpperCase()}`, bold: true, size: 28, font: "Georgia" })],
                spacing: { after: 300 },
              }),
              ...paragraphs,
            ],
          },
        ],
      });
      const blob = await Packer.toBlob(doc);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `idiomoptima-${domain}.docx`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (e) {
      console.error("Failed to export Word:", e);
    }
  };

  const exportAsPDF = () => {
    if (!result) return;
    try {
      const doc = new jsPDF();
      doc.setFont("Helvetica", "bold");
      doc.setFontSize(14);
      doc.text(`IdiomOptima - ${domain.toUpperCase()}`, 20, 20);
      doc.setFont("Helvetica", "normal");
      doc.setFontSize(10);
      doc.text(`Dialect: ${result.detectedDialect || forcedDialect} | Score: ${result.originalScore}% → ${result.revisedScore}%`, 20, 27);
      doc.setFont("Times", "normal");
      doc.setFontSize(11);
      doc.text(doc.splitTextToSize(result.finalVersion, 170), 20, 40);
      doc.save(`idiomoptima-${domain}.pdf`);
    } catch (e) {
      console.error("Failed to export PDF:", e);
    }
  };

  // Count real content words: strip markdown bold markers and exclude
  // footnote/reference lines (e.g. "[1] Author, Year.") so headings and
  // citations don't inflate the displayed total. NOTE: `\b` after "]" would
  // never match (bracket+space are both non-word chars), silently leaking
  // footnotes back into the count — dropped it so the badge stays honest.
  const wordCount = (t: string) => {
    if (!t) return 0;
    const cleaned = t
      .replace(/\*\*/g, " ")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !/^\s*(\[\d+\]|Ibid\.?)(?:\s|$)/i.test(line))
      .join(" ");
    return cleaned.trim().split(/\s+/).filter(Boolean).length;
  };

  const plainTextInput = (() => {
    const d = document.createElement("div");
    d.innerHTML = inputHtml;
    return d.textContent || d.innerText || "";
  })();

  return (
    <div className="min-h-screen bg-[#0A192F] text-slate-100 flex flex-col font-sans selection:bg-blue-600 selection:text-white">

      {/* ─── Header ─── */}
      <header className="border-b border-white/10 bg-[#0A192F]/90 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 h-16 flex items-center">
          <button
            onClick={() => navigate("/")}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white hover:bg-white/10 transition-all border border-white/15 cursor-pointer shrink-0"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Back to Overview</span>
          </button>

          <div className="flex-1 flex justify-center">
            <h1 className="font-serif text-3xl sm:text-4xl font-black tracking-tight text-white select-none">
              IdiomOptima
            </h1>
          </div>

          <div className="shrink-0 flex items-center justify-end gap-3">
            {tierInfo && (
              tierInfo.tier === "free" ? (
                <button
                  onClick={startUpgrade}
                  disabled={upgradeLoading}
                  title="Upgrade to Pro for unlimited runs"
                  className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-full text-[11px] font-bold text-amber-300 bg-amber-400/10 border border-amber-400/40 hover:bg-amber-400/20 transition-all cursor-pointer disabled:opacity-50"
                >
                  <Crown className="w-3.5 h-3.5" />
                  <span className="font-mono">{runsLeft}/{runLimit}</span>
                  <span className="hidden sm:inline">free · Upgrade</span>
                </button>
              ) : (
                <button
                  onClick={startManage}
                  disabled={portalLoading}
                  title="Manage subscription"
                  className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-full text-[11px] font-bold text-emerald-300 bg-emerald-400/10 border border-emerald-400/40 hover:bg-emerald-400/20 transition-all cursor-pointer disabled:opacity-50"
                >
                  <Crown className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">{tierInfo.tier === "enterprise" ? "Enterprise" : "Pro"}</span>
                  <CreditCard className="w-3 h-3" />
                </button>
              )
            )}
            <UserButton
              afterSignOutUrl="/"
              appearance={{
                elements: {
                  avatarBox: "w-8 h-8",
                },
              }}
            />
          </div>
        </div>
      </header>

      {/* ─── Controls Bar: Presets + Dialect + Register + Tone ─── */}
      <div className="border-b border-white/10 bg-[#0F2744]">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          {/* Preset buttons */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mr-1">Load:</span>
            {PRESETS.map((preset, i) => (
              <button
                key={i}
                onClick={() => loadPreset(preset)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer border ${
                  domain === preset.domain
                    ? "bg-blue-500/20 text-blue-300 border-blue-400/40"
                    : "bg-white/5 text-slate-300 border-white/10 hover:bg-white/10 hover:text-white"
                }`}
              >
                {preset.name}
              </button>
            ))}
          </div>

          <div className="h-5 w-px bg-white/10 hidden sm:block" />

          {/* Compact selectors */}
          <div className="flex items-center gap-2">
            <Languages className="w-3.5 h-3.5 text-blue-400" />
            <select
              value={forcedDialect}
              onChange={(e) => {
                const v = e.target.value;
                setForcedDialect(v);
                try { localStorage.setItem("idiomoptima.dialect", v); } catch {}
              }}
              className="h-8 text-xs font-semibold bg-[#0A192F] border border-white/20 rounded-lg px-2 text-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {DIALECTS.map((d) => (
                <option key={d.value} value={d.value} className="bg-[#0A192F]">{d.label}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="h-8 text-xs font-semibold bg-[#0A192F] border border-white/20 rounded-lg px-2 text-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {DOMAINS.map((dm) => (
                <option key={dm.value} value={dm.value} className="bg-[#0A192F]">{dm.label}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              className="h-8 text-xs font-semibold bg-[#0A192F] border border-white/20 rounded-lg px-2 text-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {TONES.map((t) => (
                <option key={t.value} value={t.value} className="bg-[#0A192F]">{t.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ─── Main Workspace ─── */}
      <main className="max-w-[1600px] w-full mx-auto px-4 sm:px-6 py-5 flex-1 flex flex-col gap-5">
        {banner && (
          <div className="flex items-center justify-between gap-3 bg-amber-500/10 border border-amber-400/30 rounded-xl px-4 py-2.5 text-xs text-amber-200">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-amber-300 shrink-0" />
              {banner}
            </span>
            <button onClick={() => setBanner(null)} className="text-amber-300 hover:text-white transition-colors cursor-pointer shrink-0" aria-label="Dismiss">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch flex-1 min-h-[580px]">

          {/* LEFT: Source Editor */}
          <section className="lg:col-span-6 flex flex-col bg-white text-slate-900 rounded-3xl overflow-hidden shadow-2xl border border-slate-200">
            <div className="px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <PenLine className="w-4 h-4 text-blue-600" />
                <span className="text-xs uppercase font-bold tracking-wider text-slate-800">Source Draft</span>
                <span className="text-xs px-2.5 py-0.5 bg-blue-100 text-blue-800 rounded-full font-bold">{wordCount(plainTextInput)} words</span>
              </div>
              <button onClick={handleClear} className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition-colors rounded-lg cursor-pointer">
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
            </div>

            <div className="flex-1 min-h-[440px] p-2 bg-white relative flex flex-col">
              {languageNotice && (
                <div className="mx-1 mb-2 px-3 py-2.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-800 text-xs flex items-start gap-2.5">
                  <Languages className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
                  <div>
                    <span className="font-bold block text-amber-900 text-[13px] mb-0.5">English text required</span>
                    <span>{languageNotice}</span>
                  </div>
                </div>
              )}
              <RichTextEditor content={inputHtml} onChange={(h) => { setInputHtml(h); if (languageNotice) setLanguageNotice(null); }} />
            </div>

            <div className="p-4 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Zero text retention. Citations preserved.</span>
                </div>
                {tierInfo && tierInfo.tier === "free" && (
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-blue-700 flex-wrap">
                    <Crown className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                    <span>
                      You have <span className="font-bold">{runsLeft}</span> of {runLimit} free runs left today · up to <span className="font-bold">{FREE_WORD_LIMIT}</span> words each.
                    </span>
                    <button onClick={startUpgrade} disabled={upgradeLoading} className="underline font-bold text-blue-900 hover:text-blue-600 cursor-pointer disabled:opacity-50">
                      Upgrade
                    </button>
                  </div>
                )}
              </div>
              <button
                onClick={handleTransform}
                disabled={loading || !plainTextInput.trim()}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-7 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-bold transition-all shadow-lg shadow-blue-500/25 active:scale-95 cursor-pointer"
              >
                {loading ? (
                  <><RefreshCw className="w-4 h-4 animate-spin" /><span>Nativizing ({progress}%, {elapsedSec}s)...</span></>
                ) : (
                  <><PenTool className="w-4 h-4" /><span>Nativize Prose</span><ArrowRight className="w-4 h-4" /></>
                )}
              </button>
            </div>
          </section>

          {/* RIGHT: Output Panel */}
          <section className="lg:col-span-6 flex flex-col bg-[#0F2744] text-white rounded-3xl overflow-hidden shadow-2xl border border-white/15 backdrop-blur-md">
            {/* Tabs + Export */}
            <div className="border-b border-white/10 bg-[#0A192F]/80 px-4 sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-3 h-12">
                <div className="flex items-center gap-1">
                  {([
                    { key: "fulltext" as const, icon: Layers, label: "Full Prose" },
                    { key: "diff" as const, icon: SplitSquareVertical, label: "Track Changes" },
                    { key: "notes" as const, icon: FileText, label: "Notes" },
                  ]).map(({ key, icon: Icon, label }) => (
                    <button
                      key={key}
                      onClick={() => setOutputViewMode(key)}
                      disabled={!result}
                      className={`h-12 px-3 text-xs font-bold uppercase tracking-wider relative transition-colors cursor-pointer flex items-center gap-1.5 ${
                        outputViewMode === key ? "text-blue-400" : "text-slate-400 hover:text-white"
                      } disabled:opacity-30`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">{label}</span>
                      {key === "notes" && result?.suggestions && result.suggestions.length > 0 && (
                        <span className="px-1.5 py-0.2 bg-blue-500/30 text-blue-300 text-[10px] font-bold rounded-full border border-blue-400/30">{result.suggestions.length}</span>
                      )}
                      {outputViewMode === key && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />}
                    </button>
                  ))}
                </div>
                {result && (
                  <div className="flex items-center gap-1.5">
                    <button onClick={handleCopyFullText} className="p-1.5 px-2.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs gap-1.5 flex items-center text-white transition-all cursor-pointer">
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Clipboard className="w-3.5 h-3.5 text-slate-300" />}
                      <span className="text-[11px] font-semibold">{copied ? "Copied" : "Copy"}</span>
                    </button>
                    <button onClick={exportAsPDF} className="p-1.5 px-2.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs gap-1 flex items-center text-white transition-all cursor-pointer">
                      <FileText className="w-3.5 h-3.5 text-slate-300" /><span className="text-[11px] font-semibold">PDF</span>
                    </button>
                    <button onClick={exportAsWord} className="p-1.5 px-2.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs gap-1 flex items-center text-white transition-all cursor-pointer">
                      <Download className="w-3.5 h-3.5 text-slate-300" /><span className="text-[11px] font-semibold">Word</span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Output Body */}
            <div className="flex-1 flex flex-col overflow-y-auto p-4 sm:p-6">
              {loading ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-black/20 rounded-2xl border border-white/5">
                  <div className="relative w-16 h-16 flex items-center justify-center mb-5">
                    <div className="absolute inset-0 border-4 border-blue-500/20 border-t-blue-400 rounded-full animate-spin" />
                    <PenTool className="w-6 h-6 text-blue-400 animate-pulse" />
                  </div>
                  <h3 className="font-serif text-xl font-bold text-white mb-1">Nativizing... <span className="text-blue-300 text-base font-mono">{elapsedSec}s</span></h3>
                  <p className="text-xs text-slate-300 mb-6 max-w-sm leading-relaxed">{progressPhase}</p>
                  <div className="w-56 h-2 bg-white/10 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-300 rounded-full" style={{ width: `${progress}%` }} />
                  </div>
                  <p className="text-[11px] text-slate-400 mt-4">Provider queues can take 30–90s per attempt; this is normal for the free tier.</p>
                </div>
              ) : limitPanel ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-amber-500/5 border border-amber-400/30 rounded-2xl">
                  <Crown className="w-10 h-10 text-amber-300 mb-3" />
                  {limitPanel === "words" ? (
                    <>
                      <h3 className="font-bold text-base text-amber-200 mb-1">This draft is too long for the free plan</h3>
                      <p className="text-xs text-slate-300 max-w-md leading-relaxed mb-6">
                        Your draft is <span className="font-bold text-amber-200">{wordCount(plainTextInput)} words</span> — free runs are capped at{" "}
                        <span className="font-bold text-amber-200">{FREE_WORD_LIMIT}</span> words each.
                        Upgrade to Pro for unlimited length — cancel anytime.
                      </p>
                    </>
                  ) : (
                    <>
                      <h3 className="font-bold text-base text-amber-200 mb-1">You've reached your daily free limit</h3>
                      <p className="text-xs text-slate-300 max-w-md leading-relaxed mb-6">
                        You've used all {tierInfo ? tierInfo.usage : runLimit} of {runLimit} free runs today; the counter resets at midnight.
                        Upgrade to Pro for unlimited transformations — cancel anytime.
                      </p>
                    </>
                  )}
                  <div className="flex items-center gap-3 flex-wrap justify-center">
                    <button onClick={startUpgrade} disabled={upgradeLoading} className="px-6 py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-[#0A192F] rounded-xl font-bold text-xs transition-all cursor-pointer disabled:opacity-50 inline-flex items-center gap-2">
                      <CreditCard className="w-4 h-4" />
                      {upgradeLoading ? "Opening checkout..." : "Upgrade to Pro · $9/mo"}
                    </button>
                    <button onClick={() => setLimitPanel(null)} className="px-4 py-2.5 bg-white/5 hover:bg-white/10 text-slate-300 rounded-xl font-semibold text-xs transition-all cursor-pointer">
                      Continue on Free
                    </button>
                  </div>
                </div>
              ) : error ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-rose-950/30 border border-rose-500/30 rounded-2xl">
                  <Info className="w-10 h-10 text-rose-400 mb-3" />
                  <h3 className="font-bold text-base text-rose-200 mb-1">Something went wrong</h3>
                  <p className="text-xs text-slate-300 max-w-md leading-relaxed mb-6">{error}</p>
                  <button onClick={handleTransform} className="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-xl font-bold text-xs transition-all cursor-pointer">Retry</button>
                </div>
              ) : result ? (
                <div className="space-y-5 flex-1 flex flex-col">
                  {/* Score strip */}
                  <div className="grid grid-cols-3 gap-3 p-4 bg-black/30 border border-white/10 rounded-2xl">
                    <div className="space-y-0.5">
                      <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold block">Original</span>
                      <span className="text-xl font-serif font-bold text-rose-300">{result.originalScore}%</span>
                    </div>
                    <div className="space-y-0.5">
                      <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold block">Refined</span>
                      <span className="text-xl font-serif font-bold text-emerald-300">{result.revisedScore}%</span>
                    </div>
                    <div className="space-y-0.5">
                      <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold block">Dialect</span>
                      <span className="text-xl font-serif font-bold text-blue-300">{result.detectedDialect || "US"}</span>
                    </div>
                  </div>

                  {/* Full prose view */}
                  {outputViewMode === "fulltext" && (
                    <div className="space-y-4 flex-1">
                      <div className="p-6 bg-black/30 border border-white/10 rounded-2xl">
                        <div className="flex items-center justify-between pb-3 mb-4 border-b border-white/10">
                          <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 flex items-center gap-1.5">
                            <Eye className="w-3.5 h-3.5 text-blue-400" />
                            Hover a highlighted sentence to see the original; click ✎ to edit, or revert.
                          </span>
                          <span className="text-xs text-blue-300 font-semibold">{wordCount(result.finalVersion)} words</span>
                        </div>
                        <div className="font-serif text-lg leading-relaxed text-slate-100 border-l-2 border-blue-500 pl-4 py-2">
                          {result.sentences.map((s, i) => {
                            const isFootnote = s.isImmutableFootnote;
                            const isBoldHeading = /^\*\*/.test(effectiveRevised(i)) || /^\*\*/.test(s.original);
                            const rawDisplay = effectiveRevised(i);
                            const displayRevised = rawDisplay.replace(/^\*\*/, "").replace(/\*\*$/, "");
                            const isHeadingPara = (txt: string) => {
                              const t = txt.trim().replace(/^\*\*/, "").replace(/\*\*$/, "").trim();
                              // Allow headings up to 80, but also longer academic titles like "Mapping theories..."
                              return t.length > 0 && t.length < 140 && /^[A-Z]/.test(t) && !/[.!?]$/.test(t) && !/^\[\d+\]/.test(t) && !t.includes("  ");
                            };
                            const rawChanged = s.original.trim() !== effectiveRevised(i).trim();
                            const isChanged = rawChanged && !isBoldHeading && s.explanation !== "No corrections needed.";
                            const isLast = i === result.sentences.length - 1;
                            const nextSentence = result.sentences[i + 1];
                            // Paragraph breaks: rely on the worker's explicit
                            // paragraphIndex grouping when present (deterministic,
                            // faithful to the source structure); fall back to the
                            // old heading/footnote heuristic otherwise.
                            const nextHasIdx = (n: any) => typeof (n && n.paragraphIndex) === "number";
                            const breakByIndex = !isLast && typeof s.paragraphIndex === "number" && nextSentence && nextHasIdx(nextSentence) && nextSentence.paragraphIndex !== s.paragraphIndex;
                            const endsParagraph = !isLast && (
                              (typeof s.paragraphIndex === "number" && breakByIndex) ||
                              (!nextHasIdx(s) && (
                                effectiveRevised(i).includes("\n\n") ||
                                s.original.includes("\n\n") ||
                                isBoldHeading ||
                                (nextSentence && isHeadingPara(nextSentence.original)) ||
                                (nextSentence && isHeadingPara(nextSentence.revised)) ||
                                (nextSentence && /^\[?\d/.test(nextSentence.original.trim())) ||
                                (nextSentence && nextSentence.isImmutableFootnote)
                              ))
                            );
                            return (
                              <span key={i} className="relative">
                                <span
                                  onMouseEnter={() => setHoverIdx(i)}
                                  onMouseLeave={() => setHoverIdx((h) => (h === i ? null : h))}
                                  onClick={() => {
                                    if (!isChanged) return;
                                    setEditingIdx((e) => (e === i ? null : i));
                                    setDrafts((d) => ({ ...d, [i]: effectiveRevised(i) }));
                                  }}
                                  className={`cursor-pointer ${isBoldHeading ? "block font-bold text-white text-xl my-2 " : "inline "}px-0.5 py-0.5 rounded transition-all ${
                                    isBoldHeading ? ""
                                    : editingIdx === i ? "bg-amber-400/30 text-amber-200 font-medium"
                                    : isChanged ? "bg-blue-500/20 text-blue-100 hover:bg-blue-500/30"
                                    : isFootnote ? "text-slate-400 text-base italic"
                                    : "hover:bg-white/10"
                                  }`}
                                >
                                  {displayRevised}
                                </span>
                                {/* Hover overlay: show original + revert + inline edit */}
                                {hoverIdx === i && isChanged && !isBoldHeading && (
                                  <span
                                    onMouseEnter={() => setHoverIdx(i)}
                                    onMouseLeave={() => setHoverIdx(null)}
                                    className="absolute z-30 -top-2 left-0 translate-y-[-100%] block w-[340px] max-w-[90vw] bg-[#0F172A] border border-white/15 rounded-xl shadow-2xl p-3 text-left"
                                  >
                                    <span className="block text-[10px] uppercase tracking-wider text-rose-400 font-bold mb-1">Original</span>
                                    <span className="block text-xs italic font-sans text-slate-300 leading-relaxed mb-2">{s.original}</span>
                                    <span className="block text-[10px] uppercase tracking-wider text-emerald-400 font-bold mb-1 mt-2">Revised</span>
                                    <span className="block text-xs font-sans leading-relaxed mb-2 text-emerald-100">
                                      <DiffSpans
                                        orig={(s.original || "").replace(/^\*\*/, "").replace(/\*\*$/, "")}
                                        rev={(drafts[i] ?? effectiveRevised(i)).replace(/^\*\*/, "").replace(/\*\*$/, "")}
                                      />
                                    </span>
                                    {editingIdx === i ? (
                                      <>
                                        <textarea
                                          autoFocus
                                          value={drafts[i] ?? effectiveRevised(i)}
                                          onChange={(e) => setDrafts((d) => ({ ...d, [i]: e.target.value }))}
                                          className="w-full h-24 bg-black/40 border border-amber-400/40 rounded-lg p-2 text-xs font-sans text-amber-100 resize-y outline-none focus:ring-1 focus:ring-amber-500"
                                        />
                                        <span className="flex items-center gap-1.5 mt-2">
                                          <button
                                            onClick={(e) => { e.stopPropagation(); applyOverride(i, drafts[i] ?? effectiveRevised(i)); setEditingIdx(null); setHoverIdx(null); }}
                                            className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold cursor-pointer"
                                          >
                                            Save
                                          </button>
                                          <button
                                            onClick={(e) => { e.stopPropagation(); setEditingIdx(null); }}
                                            className="px-2.5 py-1 bg-white/10 hover:bg-white/20 text-slate-300 rounded-lg text-[11px] font-semibold cursor-pointer"
                                          >
                                            Cancel
                                          </button>
                                        </span>
                                      </>
                                    ) : (
                                      <span className="flex items-center gap-1.5">
                                        <button
                                          onClick={(e) => { e.stopPropagation(); setEditingIdx(i); setDrafts((d) => ({ ...d, [i]: effectiveRevised(i) })); }}
                                          className="px-2.5 py-1 bg-white/10 hover:bg-white/20 text-blue-300 rounded-lg text-[11px] font-semibold cursor-pointer"
                                        >
                                          Edit
                                        </button>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); applyOverride(i, s.original); setHoverIdx(null); }}
                                          className="px-2.5 py-1 bg-rose-600/80 hover:bg-rose-500 text-white rounded-lg text-[11px] font-bold cursor-pointer"
                                        >
                                          Use original
                                        </button>
                                      </span>
                                    )}
                                  </span>
                                )}
                                {!isLast && !endsParagraph && " "}
                                {endsParagraph && <><br /><br /></>}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Comparison view */}
                  {outputViewMode === "diff" && (
                    <div className="space-y-4 flex-1">
                      <div className="flex items-center justify-between pb-2">
                        <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 flex items-center gap-3">
                          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-rose-500/60 inline-block" /> Removed</span>
                          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-500/60 inline-block" /> Added / changed</span>
                        </span>
                        <button onClick={handleApplyToEditor} className="text-xs text-blue-400 hover:text-blue-300 font-semibold hover:underline cursor-pointer">
                          Apply All to Editor
                        </button>
                      </div>
                      <div className="p-6 bg-black/30 border border-white/10 rounded-2xl font-serif text-lg leading-relaxed text-slate-100">
                        {result.sentences.map((sentence, idx) => {
                          const o = (sentence.original || "").replace(/^\*\*/, "").replace(/\*\*$/, "");
                          const r = (effectiveRevised(idx) || "").replace(/^\*\*/, "").replace(/\*\*$/, "");
                          const isFootnote = sentence.isImmutableFootnote;
                          const isNewPara =
                            idx > 0 &&
                            typeof sentence.paragraphIndex === "number" &&
                            typeof (result.sentences[idx - 1] && result.sentences[idx - 1].paragraphIndex) === "number" &&
                            sentence.paragraphIndex !== result.sentences[idx - 1].paragraphIndex;
                          if (isFootnote && o === r) {
                            return (
                              <Fragment key={idx}>
                                {isNewPara && <><br /><br /></>}
                                <span className="text-slate-400 italic text-base">{o}{idx < result.sentences.length - 1 ? " " : ""}</span>
                              </Fragment>
                            );
                          }
                          if (o === r) {
                            return (
                              <Fragment key={idx}>
                                {isNewPara && <><br /><br /></>}
                                <span>{r}{idx < result.sentences.length - 1 ? " " : ""}</span>
                              </Fragment>
                            );
                          }
                          // Changed sentence: word-level diff (removed struck-through,
                          // added highlighted) so subtle edits are visible.
                          return (
                            <Fragment key={idx}>
                              {isNewPara && <><br /><br /></>}
                              <DiffSpans orig={o} rev={r} />
                              {idx < result.sentences.length - 1 ? " " : ""}
                            </Fragment>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Notes view */}
                  {outputViewMode === "notes" && (
                    <div className="p-4 bg-black/30 border border-white/10 rounded-2xl flex-1 overflow-y-auto">
                      <h4 className="text-xs uppercase font-bold tracking-wider text-white mb-3 flex items-center gap-2">
                        <FileText className="w-4 h-4 text-amber-400" /> Diagnostics
                      </h4>
                      {result.timing && (
                        <div className="p-2 mb-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-[11px] text-amber-200 font-mono">
                          Provider: {result.provider} &middot; {Math.round(result.timing.totalMs / 1000)}s
                          {result.timing.attempts.length > 1 ? ` (${result.timing.attempts.length} attempts)` : ""}
                        </div>
                      )}
                      <div className="space-y-2.5">
                        {result.suggestions && result.suggestions.length > 0 ? (
                          result.suggestions.map((s, i) => (
                            <div key={i} className="p-3 bg-white/5 border border-white/10 rounded-xl text-xs text-slate-200 flex gap-2.5">
                              <span className="text-blue-400 font-bold">{i + 1}.</span>
                              <p className="leading-relaxed">{s}</p>
                            </div>
                          ))
                        ) : (
                          <div className="p-3 bg-white/5 border border-white/10 rounded-xl text-xs text-slate-200">
                            <p className="leading-relaxed">No diagnostics available.</p>
                          </div>
                        )}

                        {result.databaseStats && result.databaseStats.totalReplacements > 0 && (
                          <div className="p-3 bg-amber-950/30 border border-amber-500/20 rounded-xl text-xs">
                            <span className="text-[10px] uppercase font-bold tracking-wider text-amber-400 block mb-1.5">Database Activity</span>
                            <div className="space-y-1 text-slate-300">
                              {result.databaseStats.aiPhraseReplacements > 0 && <p>AI-ese phrases replaced: {result.databaseStats.aiPhraseReplacements}</p>}
                              {result.databaseStats.idiomReplacements > 0 && <p>Idiom improvements: {result.databaseStats.idiomReplacements}</p>}
                              {result.databaseStats.lexicalReplacements > 0 && <p>Lexical replacements ({domain}): {result.databaseStats.lexicalReplacements}</p>}
                            </div>
                          </div>
                        )}

                        {result.databaseLine && (
                          <div className="p-3 bg-teal-950/30 border border-teal-500/20 rounded-xl text-xs">
                            <span className="text-[10px] uppercase font-bold tracking-wider text-teal-400 block mb-1.5">Nativization</span>
                            <p className="leading-relaxed text-slate-300">{result.databaseLine}</p>
                            {result.coverage && (
                              <p className="leading-relaxed text-slate-400 mt-2">
                                Coverage: matched <strong className="text-teal-300">{result.coverage.matched}</strong> stiff phrase{result.coverage.matched === 1 ? "" : "s"} in the source rule set
                                {result.coverage.uncovered.length > 0 && (
                                  <>
                                    {" "}· {result.coverage.uncovered.length} common stiff pattern{result.coverage.uncovered.length === 1 ? "" : "s"} present but not auto-edited (left to the model/author): {result.coverage.uncovered.map(p => `“${p}”`).join(", ")}
                                  </>
                                )}
                                {result.coverage.uncovered.length === 0 && (
                                  <> · every detectable stiff phrase was inside the rule set</>
                                )}
                              </p>
                            )}
                          </div>
                        )}

                        {result.explanation && (
                          <div className="p-3 bg-indigo-950/30 border border-indigo-500/20 rounded-xl">
                            <span className="text-[10px] uppercase font-bold tracking-wider text-indigo-400 block mb-1">Summary</span>
                            <p className="text-xs text-slate-300 leading-relaxed">{result.explanation}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-black/20 rounded-2xl border border-white/5">
                  <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-500/20 to-indigo-500/20 text-blue-400 flex items-center justify-center mb-4 border border-blue-400/20">
                    <PenTool className="w-7 h-7" />
                  </div>
                  <h3 className="font-serif text-xl font-bold text-white mb-2">Ready to Nativize</h3>
                  <p className="text-xs text-slate-300 max-w-sm leading-relaxed mb-6">
                    Choose a sample above or paste your own text on the left, then click <strong className="text-blue-400">Nativize Prose</strong>.
                  </p>
                  <div className="space-y-2 w-full max-w-sm text-left bg-black/30 p-4 border border-white/10 rounded-2xl text-xs text-slate-300">
                    <div className="flex gap-2.5 items-start"><CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" /><span>Hover to edit, revert, or inspect each change inline</span></div>
                    <div className="flex gap-2.5 items-start"><CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" /><span>Citations [1,2] & formulas preserved</span></div>
                    <div className="flex gap-2.5 items-start"><CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" /><span>Word (.docx) & PDF export</span></div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            {result && (
              <div className="px-5 py-2.5 border-t border-white/10 bg-[#0A192F]/90 flex items-center justify-between text-xs text-slate-400">
                <span>{wordCount(result.finalVersion)} words</span>
                <span>Dialect: <strong className="text-blue-300">{result.detectedDialect || forcedDialect}</strong></span>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}