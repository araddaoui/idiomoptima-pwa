import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
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
  Copy,
  CheckCircle2,
  Feather,
} from "lucide-react";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { jsPDF } from "jspdf";
import { RichTextEditor } from "../components/RichTextEditor";
import { transformText, TransformationResult } from "../services/geminiService";

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
  const { getToken } = useAuth();
  const [inputHtml, setInputHtml] = useState<string>(PRESETS[0].html);
  const [forcedDialect, setForcedDialect] = useState<string>("auto");
  const [domain, setDomain] = useState<string>("academic");
  const [tone, setTone] = useState<string>("neutral");

  const [loading, setLoading] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [progressPhase, setProgressPhase] = useState<string>("");
  const [result, setResult] = useState<TransformationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedSentenceIdx, setSelectedSentenceIdx] = useState<number | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [copiedSentenceIdx, setCopiedSentenceIdx] = useState<number | null>(null);
  const [outputViewMode, setOutputViewMode] = useState<"comparison" | "fulltext" | "notes">("fulltext");

  const [idiomDatabase, setIdiomDatabase] = useState<any[]>([]);
  const [aiPhraseMap, setAiPhraseMap] = useState<any[]>([]);
  const [lexicalDatabases, setLexicalDatabases] = useState<Record<string, any[]>>({});

  useEffect(() => {
    const loadDatabases = async () => {
      try {
        const idiomRes = await fetch("/idioms-clunky-native.json");
        if (idiomRes.ok) setIdiomDatabase(await idiomRes.json());
      } catch {}
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
        setAiPhraseMap(Array.from(merged.values()));
      } catch {}
      try {
        const lexResult: Record<string, any[]> = {};
        for (const d of ["academic", "business", "creative", "general"]) {
          const res = await fetch(`/lexical-${d}.json`);
          if (res.ok) lexResult[d] = await res.json();
        }
        setLexicalDatabases(lexResult);
      } catch {}
    };
    loadDatabases();
  }, []);

  const handleTransform = async () => {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = inputHtml;
    const plainText = tempDiv.textContent || tempDiv.innerText || "";
    if (!plainText.trim()) {
      setError("Please write or paste some text into the editor first.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedSentenceIdx(null);
    setProgress(0);
    setProgressPhase("Analyzing sentence cadence & register markers...");
    try {
      const token = await getToken();
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
        { idiomDatabase, aiPhraseMap, lexicalDatabases },
        token || undefined
      );
      setResult(response);
      setSelectedSentenceIdx(0);
    } catch (err: any) {
      setError(err.message || "Something went wrong during transformation.");
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    setInputHtml("<p></p>");
    setResult(null);
    setSelectedSentenceIdx(null);
    setError(null);
  };

  const loadPreset = (preset: (typeof PRESETS)[0]) => {
    setInputHtml(preset.html);
    setDomain(preset.domain);
    setForcedDialect(preset.dialect);
    setTone(preset.tone);
    setResult(null);
    setSelectedSentenceIdx(null);
    setError(null);
  };

  const handleCopyFullText = () => {
    if (!result) return;
    navigator.clipboard.writeText(result.finalVersion);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopySentence = (text: string, idx: number) => {
    navigator.clipboard.writeText(text);
    setCopiedSentenceIdx(idx);
    setTimeout(() => setCopiedSentenceIdx(null), 2000);
  };

  const handleApplyToEditor = () => {
    if (!result) return;
    setInputHtml(`<p>${result.sentences.map((s) => s.revised).join(" ")}</p>`);
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

  const wordCount = (t: string) => (t ? t.trim().split(/\s+/).filter(Boolean).length : 0);

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

          <div className="w-[140px] shrink-0 flex justify-end">
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
              onChange={(e) => setForcedDialect(e.target.value)}
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
              <RichTextEditor content={inputHtml} onChange={setInputHtml} />
            </div>

            <div className="p-4 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>Zero text retention. Citations preserved.</span>
              </div>
              <button
                onClick={handleTransform}
                disabled={loading || !plainTextInput.trim()}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 px-7 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-sm font-bold transition-all shadow-lg shadow-blue-500/25 active:scale-95 cursor-pointer"
              >
                {loading ? (
                  <><RefreshCw className="w-4 h-4 animate-spin" /><span>Nativizing ({progress}%)...</span></>
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
                    { key: "comparison" as const, icon: SplitSquareVertical, label: "Comparison" },
                    { key: "notes" as const, icon: FileText, label: "Notes" },
                  ]).map(({ key, icon: Icon, label }) => (
                    <button
                      key={key}
                      onClick={() => setOutputViewMode(key)}
                      disabled={key !== "comparison" && !result}
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
                  <h3 className="font-serif text-xl font-bold text-white mb-1">Nativizing...</h3>
                  <p className="text-xs text-slate-300 mb-6 max-w-sm leading-relaxed">{progressPhase}</p>
                  <div className="w-56 h-2 bg-white/10 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-300 rounded-full" style={{ width: `${progress}%` }} />
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
                            Hover to see original. Click to compare.
                          </span>
                          <span className="text-xs text-blue-300 font-semibold">{wordCount(result.finalVersion)} words</span>
                        </div>
                        <div className="font-serif text-lg leading-relaxed text-slate-100 border-l-2 border-blue-500 pl-4 py-2">
                          {result.sentences.map((s, i) => {
                            const isFootnote = s.isImmutableFootnote;
                            const isChanged = s.original.trim() !== s.revised.trim();
                            const isLast = i === result.sentences.length - 1;
                            const nextSentence = result.sentences[i + 1];
                            const endsParagraph = !isLast && (
                              s.revised.includes("\n\n") ||
                              s.original.includes("\n\n") ||
                              (nextSentence && /^\[?\d/.test(nextSentence.original)) ||
                              (nextSentence && /^[A-Z][a-z]+:/.test(nextSentence.original)) ||
                              (nextSentence && nextSentence.isImmutableFootnote)
                            );
                            return (
                              <span key={i}>
                                <span
                                  onClick={() => { setSelectedSentenceIdx(i); setOutputViewMode("comparison"); }}
                                  title={s.original}
                                  className={`inline px-1 py-0.5 rounded transition-all cursor-pointer ${
                                    selectedSentenceIdx === i ? "bg-amber-400/30 text-amber-200 font-medium underline"
                                    : isChanged ? "bg-blue-500/20 text-blue-100 hover:bg-blue-500/30"
                                    : isFootnote ? "text-slate-400 text-base italic hover:bg-white/10"
                                    : "hover:bg-white/10"
                                  }`}
                                >
                                  {s.revised}
                                </span>
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
                  {outputViewMode === "comparison" && (
                    <div className="space-y-3 flex-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400">
                          Sentence Breakdown ({result.sentences.length})
                        </span>
                        <button onClick={handleApplyToEditor} className="text-xs text-blue-400 hover:text-blue-300 font-semibold hover:underline cursor-pointer">
                          Apply All to Editor
                        </button>
                      </div>
                      <div className="space-y-3">
                        {result.sentences.map((sentence, idx) => {
                          const hasChanged = sentence.original.trim() !== sentence.revised.trim();
                          return (
                            <div
                              key={idx}
                              onClick={() => setSelectedSentenceIdx(idx)}
                              className={`border rounded-2xl p-4 transition-all cursor-pointer ${
                                selectedSentenceIdx === idx
                                  ? "bg-blue-950/70 border-blue-400/60 shadow-lg shadow-blue-950/60"
                                  : "bg-black/20 border-white/10 hover:border-white/20"
                              }`}
                            >
                              <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-2">
                                  <span className="w-5 h-5 rounded-full bg-white/10 text-slate-300 text-[10px] font-bold flex items-center justify-center font-mono">{idx + 1}</span>
                                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${hasChanged ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30" : "bg-white/10 text-slate-400"}`}>
                                    {hasChanged ? "Nativized" : "Preserved"}
                                  </span>
                                </div>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleCopySentence(sentence.revised, idx); }}
                                  className="p-1 px-2 rounded-md bg-white/5 hover:bg-white/15 text-[11px] text-slate-300 flex items-center gap-1 transition-all cursor-pointer"
                                >
                                  {copiedSentenceIdx === idx ? <><Check className="w-3 h-3 text-emerald-400" /><span className="text-emerald-300">Copied</span></> : <><Copy className="w-3 h-3 text-slate-400" /><span>Copy</span></>}
                                </button>
                              </div>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                                <div className="bg-black/40 border border-rose-500/20 rounded-xl p-3">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-rose-400 block mb-1">Original:</span>
                                  <p className="text-slate-300 text-xs italic font-serif leading-relaxed">"{sentence.original}"</p>
                                </div>
                                <div className="bg-blue-950/60 border border-emerald-400/30 rounded-xl p-3">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 block mb-1">Refined:</span>
                                  <p className="text-blue-50 text-sm font-medium font-serif leading-relaxed">"{sentence.revised}"</p>
                                </div>
                              </div>
                              {sentence.explanation && (
                                <div className="pt-2 border-t border-white/10 text-xs text-slate-300 flex items-start gap-2">
                                  <Info className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                                  <span className="leading-relaxed">{sentence.explanation}</span>
                                </div>
                              )}
                            </div>
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
                    <div className="flex gap-2.5 items-start"><CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" /><span>Sentence-by-sentence comparison</span></div>
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