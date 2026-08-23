import { useState, useEffect } from "react";
import {
  Sparkles,
  Download,
  RefreshCw,
  Trash2,
  Languages,
  PenLine,
  BookOpen,
  Briefcase,
  Activity,
  FileText,
  Info,
  CheckCircle2,
  Eye,
  Zap,
  Clipboard,
  Check,
  Feather,
} from "lucide-react";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { jsPDF } from "jspdf";
import { diff_match_patch } from "diff-match-patch";
import { RichTextEditor } from "./components/RichTextEditor";
import { transformText, TransformationResult, detectBestMode } from "./services/geminiService";

const DIALECTS = [
  { value: "auto", label: "Auto-Detect" },
  { value: "US", label: "American (US)" },
  { value: "UK", label: "British (UK)" },
  { value: "CA", label: "Canadian (CA)" },
  { value: "AU", label: "Australian (AU)" },
];

const DOMAINS = [
  { value: "general", label: "General" },
  { value: "academic", label: "Academic" },
  { value: "business", label: "Business" },
  { value: "creative", label: "Creative" },
];

const TONES = [
  { value: "neutral", label: "Neutral" },
  { value: "formal", label: "Formal" },
  { value: "informal", label: "Informal" },
  { value: "persuasive", label: "Persuasive" },
  { value: "empathetic", label: "Empathetic" },
];

export default function App() {
  const [inputHtml, setInputHtml] = useState<string>("<p>Despite of the difficulties, the research team went ahead with the methodology [1]. I mean, they probably had to, because the stakeholders wanted to find some sort of positive result. Maybe they are right, who knows. Let us analyze this.</p>");
  const [forcedDialect, setForcedDialect] = useState<string>("auto");
  const [domain, setDomain] = useState<string>("general");
  const [tone, setTone] = useState<string>("neutral");

  const [loading, setLoading] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [progressPhase, setProgressPhase] = useState<string>("");
  const [result, setResult] = useState<TransformationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedSentenceIdx, setSelectedSentenceIdx] = useState<number | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"result" | "suggestions" | "metadata">("result");

  const [showDiff, setShowDiff] = useState(false);
  const [detectedMode, setDetectedMode] = useState<{ mode: string; reason: string }>({ mode: "general", reason: "" });

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
          fetch("/ai-natural-database.json").then(r => r.ok ? r.json() : []),
          fetch("/ai-natural-database-1500.json").then(r => r.ok ? r.json() : []),
          fetch("/ai-natural-database-1000.json").then(r => r.ok ? r.json() : []),
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

  useEffect(() => {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = inputHtml;
    const text = tempDiv.textContent || tempDiv.innerText || "";
    if (text.trim()) {
      setDetectedMode(detectBestMode(text));
    }
  }, [inputHtml]);

  const handleTransform = async () => {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = inputHtml;
    const plainText = tempDiv.textContent || tempDiv.innerText || "";

    if (!plainText.trim()) {
      setError("Please write or paste some text first.");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedSentenceIdx(null);
    setProgress(0);
    setProgressPhase("Loading analytical layers...");

    try {
      const response = await transformText(
        plainText,
        domain,
        tone,
        forcedDialect === "auto" ? undefined : forcedDialect,
        (percent, _chunkIdx, _total, phase) => {
          setProgress(percent);
          if (phase) setProgressPhase(phase);
        },
        "auto",
        { idiomDatabase, aiPhraseMap, lexicalDatabases }
      );
      setResult(response);
      setActiveTab("result");
    } catch (err: any) {
      console.error(err);
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

  const handleCopy = () => {
    if (!result) return;
    navigator.clipboard.writeText(result.finalVersion);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const exportAsWord = async () => {
    if (!result) return;
    try {
      const paragraphs = result.sentences.map(s => {
        return new Paragraph({
          children: [
            new TextRun({
              text: s.revised + " ",
              font: "Georgia",
              size: 24,
            })
          ]
        });
      });

      const doc = new Document({
        sections: [{
          properties: {},
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: "IdiomOptima Document Export",
                  bold: true,
                  size: 36,
                  font: "Georgia",
                })
              ],
              spacing: { after: 300 }
            }),
            ...paragraphs
          ]
        }]
      });

      const blob = await Packer.toBlob(doc);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "idiomoptima-export.docx";
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (e) {
      console.error("Failed to export Word document:", e);
    }
  };

  const exportAsPDF = () => {
    if (!result) return;
    try {
      const doc = new jsPDF();
      doc.setFont("Helvetica", "normal");
      doc.setFontSize(16);
      doc.text("IdiomOptima - Preserved Document", 20, 20);
      doc.setFontSize(11);

      const splitText = doc.splitTextToSize(result.finalVersion, 170);
      doc.text(splitText, 20, 35);
      doc.save("idiomoptima-export.pdf");
    } catch (e) {
      console.error("Failed to export PDF doc:", e);
    }
  };

  const wordCount = (text: string) => {
    if (!text) return 0;
    return text.trim().split(/\s+/).filter(Boolean).length;
  };

  const charCount = (text: string) => {
    if (!text) return 0;
    return text.length;
  };

  const plainTextInput = (() => {
    const d = document.createElement("div");
    d.innerHTML = inputHtml;
    return d.textContent || d.innerText || "";
  })();

  const currentActiveModeInfo = () => {
    const finalMode = result?.appliedMode || detectedMode.mode;
    switch (finalMode) {
      case "academic":
        return {
          label: "Academic",
          color: "bg-indigo-50 text-indigo-700 border-indigo-200",
          icon: <BookOpen className="w-3 h-3" />,
        };
      case "business":
        return {
          label: "Business",
          color: "bg-blue-50 text-blue-700 border-blue-200",
          icon: <Briefcase className="w-3 h-3" />,
        };
      case "creative":
        return {
          label: "Creative",
          color: "bg-rose-50 text-rose-700 border-rose-200",
          icon: <Activity className="w-3 h-3" />,
        };
      default:
        return {
          label: "General",
          color: "bg-slate-50 text-slate-600 border-slate-200",
          icon: <Languages className="w-3 h-3" />,
        };
    }
  };

  const modeInfo = currentActiveModeInfo();

  const renderDiff = (original: string, native: string) => {
    const dmp = new diff_match_patch();
    const diffs = dmp.diff_main(original, native);
    dmp.diff_cleanupSemantic(diffs);
    return (
      <span>
        {diffs.map(([op, text], i) => {
          if (op === 0) return <span key={i}>{text}</span>;
          if (op === -1) return (
            <span key={i} className="bg-red-100 text-red-700 line-through rounded px-0.5">{text}</span>
          );
          if (op === 1) return (
            <span key={i} className="bg-green-100 text-green-700 font-medium rounded px-0.5">{text}</span>
          );
          return null;
        })}
      </span>
    );
  };

  const HEADING_REGEX = /^(?:#{1,4}\s+)?(?:Chapter|Section|Introduction|Conclusion|Abstract|Summary|Background|Methodology|Results|Discussion|References|Appendix|Acknowledgements|Table of Contents|Literature Review|Problem Statement|Objectives?|Scope|Limitations?|Deliverables?|Timeline|Budget|Recommendations?)\b/i;
  const FOOTNOTE_DEF_REGEX = /^\s*(?:\[?(\d{1,3})\]?[\s.:)\-|]{1,3}|Footnote\s*(\d{1,3})|REFERENCE\s+(\d{1,3}))[\s.:)\-|]*\s*(.+)/i;
  const HEADING_MARKER_REGEX = /^#{1,4}\s+/;

  const tagSentence = (sent: any) => {
    const text = (sent.original || "").trim();
    const words = text.split(/\s+/);
    const isShortLine = words.length <= 8;
    const noTrailingPeriod = !/[.!?]\s*$/.test(text) && !/[.!?]$/.test(text);
    const isHeadingLike = isShortLine && noTrailingPeriod && HEADING_REGEX.test(text);
    const headingMatch = text.match(HEADING_MARKER_REGEX);
    if (headingMatch) {
      return { ...sent, isHeading: true, headingLevel: headingMatch[1].length || 2 };
    }
    if (isHeadingLike) {
      return { ...sent, isHeading: true, headingLevel: 2 };
    }
    return { ...sent, isHeading: false, headingLevel: 0 };
  };

  const taggedSentences = (result?.sentences || []).map(tagSentence);

  const footnotes = taggedSentences.filter(s => s.isImmutableFootnote);
  const bodySentences = taggedSentences.filter(s => !s.isImmutableFootnote);

  return (
    <div className="min-h-screen bg-[#FDFDFB] text-[#1A1A1A] flex flex-col font-sans selection:bg-[#F2EFE9] selection:text-[#1a1a1a]">

      {/* ─── Hero ─── */}
      <header className="border-b border-[#EAE6DF] bg-white/70 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#1A1A1A] rounded-lg flex items-center justify-center">
              <Languages className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="font-serif text-xl font-bold tracking-tight text-[#1A1A1A]">IdiomOptima</h1>
              <p className="text-[9px] uppercase tracking-wider text-[#8C857B] font-bold">Voice Preservation Engine</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold border ${modeInfo.color}`}>
              {modeInfo.icon}
              <span>{modeInfo.label}</span>
            </div>
          </div>
        </div>
      </header>

      {/* ─── Hero Banner ─── */}
      <section className="border-b border-[#EAE6DF] bg-[#FAF9F6]">
        <div className="max-w-[1600px] mx-auto px-6 py-10 md:py-14 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#1A1A1A]/5 rounded-full text-[10px] font-bold uppercase tracking-widest text-[#8C857B] mb-5">
            <Feather className="w-3 h-3" />
            <span>AI-Powered Text Refinement</span>
          </div>

          <h2 className="font-serif text-4xl md:text-5xl lg:text-6xl font-bold text-[#1A1A1A] leading-[1.1] mb-4">
            Edit. Nativize. Humanize.
          </h2>

          <p className="text-sm md:text-base text-[#8C857B] max-w-2xl mx-auto leading-relaxed mb-6">
            Your voice, preserved. IdiomOptima refines grammar, fluency, and native expression
            while protecting your rhythm, headings, citations, and authorial intent.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3 text-[11px] font-semibold text-[#555]">
            <span className="flex items-center gap-1.5 bg-white border border-[#EAE6DF] rounded-full px-3 py-1.5">
              <CheckCircle2 className="w-3 h-3 text-green-500" />
              Voice preservation
            </span>
            <span className="flex items-center gap-1.5 bg-white border border-[#EAE6DF] rounded-full px-3 py-1.5">
              <CheckCircle2 className="w-3 h-3 text-green-500" />
              Dialect-aware
            </span>
            <span className="flex items-center gap-1.5 bg-white border border-[#EAE6DF] rounded-full px-3 py-1.5">
              <CheckCircle2 className="w-3 h-3 text-green-500" />
              Citations safe
            </span>
            <span className="flex items-center gap-1.5 bg-white border border-[#EAE6DF] rounded-full px-3 py-1.5">
              <CheckCircle2 className="w-3 h-3 text-green-500" />
              Minimal intervention
            </span>
          </div>
        </div>
      </section>

      {/* ─── Tool ─── */}
      <main className="max-w-[1600px] w-full mx-auto px-6 py-6 flex-1 flex flex-col gap-6">

        {/* Settings bar */}
        <div className="flex justify-center md:justify-start">
          <section className="w-full max-w-2xl bg-white border border-[#EAE6DF] rounded-2xl p-3 shadow-sm hover:shadow-md transition-shadow">
            <div className="grid grid-cols-3 gap-6">

              <div className="space-y-1">
                <label className="text-[9px] font-bold text-[#8C857B] uppercase tracking-[0.15em] pl-0.5 min-h-[14px] block">
                  Dialect
                </label>
                <select
                  value={forcedDialect}
                  onChange={(e) => setForcedDialect(e.target.value)}
                  className="w-full h-8 text-[11px] font-semibold bg-[#FAF9F6] border border-[#EAE6DF] rounded-lg px-2.5 text-[#1A1A1A] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#1A1A1A]"
                >
                  {DIALECTS.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[9px] font-bold text-[#8C857B] uppercase tracking-[0.15em] pl-0.5 min-h-[14px] block">
                  Domain
                </label>
                <select
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className="w-full h-8 text-[11px] font-semibold bg-[#FAF9F6] border border-[#EAE6DF] rounded-lg px-2.5 text-[#1A1A1A] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#1A1A1A]"
                >
                  {DOMAINS.map((dm) => (
                    <option key={dm.value} value={dm.value}>{dm.label}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[9px] font-bold text-[#8C857B] uppercase tracking-[0.15em] pl-0.5 min-h-[14px] block">
                  Tone
                </label>
                <select
                  value={tone}
                  onChange={(e) => setTone(e.target.value)}
                  className="w-full h-8 text-[11px] font-semibold bg-[#FAF9F6] border border-[#EAE6DF] rounded-lg px-2.5 text-[#1A1A1A] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#1A1A1A]"
                >
                  {TONES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>

            </div>
          </section>
        </div>

        {/* Editor + Output */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch flex-1">

          {/* Left: Editor */}
          <section className="lg:col-span-7 flex flex-col bg-white border border-[#EAE6DF] rounded-3xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">

            <div className="px-5 py-3 border-b border-[#EAE6DF] bg-[#FAF9F6] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PenLine className="w-3.5 h-3.5 text-[#8C857B]" />
                <span className="text-[10px] uppercase font-bold tracking-wider text-[#8C857B]">Original</span>
                <span className="text-[10px] px-1.5 py-0.5 bg-[#EAE6DF] text-[#555] rounded font-semibold">
                  {wordCount(plainTextInput)} words
                </span>
              </div>
              <button
                onClick={handleClear}
                className="p-1 text-[#8C857B] hover:text-[#DC2626] transition-colors rounded hover:bg-[#F2EFE9]"
                title="Clear"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="flex-1 min-h-[600px] bg-white relative">
              <RichTextEditor
                content={inputHtml}
                onChange={setInputHtml}
              />
            </div>

            <div className="p-4 border-t border-[#EAE6DF] bg-[#FAF9F6] flex items-center justify-between">
              <div className="text-[10px] text-[#8C857B] max-w-sm">
                Write freely. The engine preserves your voice and matches it against lexical structures in the background.
              </div>

              <button
                onClick={handleTransform}
                disabled={loading || !plainTextInput.trim()}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#1A1A1A] text-white hover:bg-[#333] disabled:bg-[#CCC] disabled:cursor-not-allowed rounded-full text-xs font-bold transition-all shadow-sm hover:shadow-md active:scale-95"
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Nativizing ({progress}%)...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Nativize & Preserve Voice</span>
                  </>
                )}
              </button>
            </div>

          </section>

          {/* Right: Output */}
          <section className="lg:col-span-5 flex flex-col bg-white border border-[#EAE6DF] rounded-3xl overflow-hidden shadow-sm hover:shadow-md transition-all">

            {/* Tabs */}
            <div className="border-b border-[#EAE6DF] bg-[#FAF9F6] px-4">
              <div className="flex items-center justify-between h-11">
                <div className="flex gap-2">
                  <button
                    onClick={() => setActiveTab("result")}
                    disabled={!result}
                    className={`h-11 px-3 text-[11px] font-bold uppercase tracking-wider relative transition-colors ${
                      activeTab === "result" ? "text-[#1A1A1A]" : "text-[#8C857B] hover:text-[#555]"
                    } disabled:opacity-40`}
                  >
                    Output
                    {activeTab === "result" && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#1A1A1A]" />}
                  </button>
                  <button
                    onClick={() => setActiveTab("suggestions")}
                    disabled={!result || result.suggestions.length === 0}
                    className={`h-11 px-3 text-[11px] font-bold uppercase tracking-wider relative transition-colors ${
                      activeTab === "suggestions" ? "text-[#1A1A1A]" : "text-[#8C857B] hover:text-[#555]"
                    } disabled:opacity-40`}
                  >
                    Diagnostics
                    {result?.suggestions && result.suggestions.length > 0 && (
                      <span className="ml-1.5 px-1.5 py-0.2 bg-[#F2C94C] text-[#333] text-[9.5px] font-black rounded-full">
                        {result.suggestions.length}
                      </span>
                    )}
                    {activeTab === "suggestions" && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#1A1A1A]" />}
                  </button>
                </div>

                {result && (
                  <div className="flex items-center gap-1.5">
                    {activeTab === "result" && (
                      <button
                        onClick={() => setShowDiff(!showDiff)}
                        className={`text-[10px] px-2 py-1 rounded-full border transition-all font-semibold ${
                          showDiff
                            ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]'
                            : 'bg-white text-[#8C857B] border-[#EAE6DF] hover:border-[#8C857B]'
                        }`}
                      >
                        {showDiff ? 'Diff On' : 'Show Diff'}
                      </button>
                    )}
                    <button
                      onClick={handleCopy}
                      className="p-1 px-2 hover:bg-[#EAE6DF] rounded text-xs gap-1 flex items-center text-[#555] transition-colors"
                      title="Copy"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Clipboard className="w-3.5 h-3.5" />}
                      <span className="text-[10px] font-semibold">{copied ? "Copied" : "Copy"}</span>
                    </button>
                    <button
                      onClick={exportAsPDF}
                      className="p-1 px-2 hover:bg-[#EAE6DF] rounded text-xs gap-1 flex items-center text-[#555] transition-colors"
                      title="Export PDF"
                    >
                      <FileText className="w-3.5 h-3.5 text-[#555]" />
                      <span className="text-[10px] font-semibold">PDF</span>
                    </button>
                    <button
                      onClick={exportAsWord}
                      className="p-1 px-2 hover:bg-[#EAE6DF] rounded text-xs gap-1 flex items-center text-[#555] transition-colors"
                      title="Export Word"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span className="text-[10px] font-semibold">Word</span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 bg-white flex flex-col overflow-y-auto">
              {loading ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-[#FAF9F6]/50">
                  <div className="relative w-16 h-16 flex items-center justify-center mb-4">
                    <div className="absolute inset-0 border-4 border-[#EAE6DF] border-t-[#1A1A1A] rounded-full animate-spin" />
                    <Sparkles className="w-5 h-5 text-[#1A1A1A]" />
                  </div>
                  <h3 className="font-serif text-lg font-bold mb-1">Preserving your voice...</h3>
                  <p className="text-xs text-[#8C857B] mb-4 max-w-xs">{progressPhase}</p>
                  <div className="w-48 h-1 bg-[#EAE6DF] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#1A1A1A] transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              ) : error ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-red-50/20">
                  <Info className="w-8 h-8 text-red-500 mb-3" />
                  <h3 className="font-bold text-sm text-red-800 mb-1">Something went wrong</h3>
                  <p className="text-xs text-[#555] max-w-sm leading-relaxed mb-4">{error}</p>
                  <button
                    onClick={handleTransform}
                    className="px-4 py-2 bg-red-100 text-red-800 rounded-full font-bold text-xs hover:bg-red-200 transition-colors"
                  >
                    Retry
                  </button>
                </div>
              ) : result ? (
                <div className="flex-1 flex flex-col h-full">

                  {activeTab === "result" && (
                    <div className="p-6 space-y-6 flex-1">

                      {/* Scores */}
                      <div className="grid grid-cols-2 gap-3 p-3.5 bg-[#FAF9F6] border border-[#EAE6DF] rounded-2xl">
                        <div className="space-y-0.5">
                          <span className="text-[9px] uppercase tracking-wider text-[#8C857B] font-bold block">Voice Integrity</span>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xl font-serif font-black">{result.originalScore}%</span>
                            <span className="text-[10px] text-green-600 font-bold">Preserved</span>
                          </div>
                        </div>
                        <div className="space-y-0.5">
                          <span className="text-[9px] uppercase tracking-wider text-[#8C857B] font-bold block">Fluency Gain</span>
                          <div className="flex items-center gap-1.5">
                            <span className="text-xl font-serif font-black">{result.revisedScore}%</span>
                            <span className="text-[10px] text-blue-600 font-bold">Enhanced</span>
                          </div>
                        </div>
                      </div>

                      {/* Review instruction */}
                      <h4 className="text-[10px] uppercase font-bold tracking-wider text-[#8C857B] flex items-center gap-1.5">
                        <Eye className="w-3 h-3" />
                        <span>{showDiff ? 'Word diff shown' : 'Click any sentence to compare'}</span>
                      </h4>

                      {/* Sentence output */}
                      <div className="prose prose-stone font-serif text-lg leading-relaxed text-[#1A1A1A] border-l-2 border-[#1A1A1A]/10 pl-4 py-1">
                        {(() => {
                          const groups: JSX.Element[] = [];
                          let currentGroup: JSX.Element[] = [];
                          let groupIdx = 0;

                          bodySentences.forEach((sent, idx) => {
                            const text = sent.isNativeMatch ? sent.original : sent.revised;
                            const content = (
                              <span
                                key={idx}
                                title={`Original: ${sent.original}`}
                                onClick={() => setSelectedSentenceIdx(idx)}
                                className={`sentence-highlight inline px-1 py-0.5 rounded transition-all cursor-pointer ${
                                  selectedSentenceIdx === idx
                                    ? "bg-amber-100 text-[#1A1A1A] font-medium scale-[1.01]"
                                    : sent.original !== sent.revised
                                    ? "bg-[#FCFBE3]/50 hover:bg-[#FCFBE3]"
                                    : "hover:bg-slate-50"
                                }`}
                              >
                                {showDiff && !sent.isNativeMatch
                                  ? renderDiff(sent.original, sent.revised)
                                  : text}
                              </span>
                            );

                            if (sent.isHeading) {
                              if (currentGroup.length > 0) {
                                groups.push(<div key={`p-${groupIdx++}`} className="mb-3 last:mb-0">{currentGroup}</div>);
                                currentGroup = [];
                              }
                              groups.push(
                                <div key={`h-${idx}`} className="mb-2 last:mb-0">
                                  {content}
                                </div>
                              );
                            } else {
                              currentGroup.push(<span key={`ws-${idx}`}> </span>);
                              currentGroup.push(content);
                              if (sent.isEndOfParagraph) {
                                groups.push(<div key={`p-${groupIdx++}`} className="mb-3 last:mb-0">{currentGroup}</div>);
                                currentGroup = [];
                              }
                            }
                          });

                          if (currentGroup.length > 0) {
                            groups.push(<div key={`p-${groupIdx}`} className="mb-3 last:mb-0">{currentGroup}</div>);
                          }

                          return groups;
                        })()}
                      </div>

                      {/* Sentence comparison */}
                      {selectedSentenceIdx !== null && (
                        <div className="border border-[#EAE6DF] rounded-2xl p-4 bg-[#FAF9F6] space-y-3.5 transform transition-all duration-300">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] uppercase font-black tracking-widest text-[#8C857B] block">
                              Sentence #{selectedSentenceIdx + 1}
                            </span>
                            <span className="text-[9.5px] shrink-0 font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded">
                              {result.sentences[selectedSentenceIdx].original === result.sentences[selectedSentenceIdx].revised
                                ? "Unchanged"
                                : "Refined"}
                            </span>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 text-xs">
                            <div className="space-y-1">
                              <span className="text-[9px] lowercase font-bold text-[#8C857B]">your draft:</span>
                              <p className="p-3 bg-white border border-[#EAE6DF] rounded-xl text-[#666] italic">
                                "{result.sentences[selectedSentenceIdx].original}"
                              </p>
                            </div>
                            <div className="space-y-1">
                              <span className="text-[9px] lowercase font-bold text-[#8C857B]">nativized:</span>
                              <p className="p-3 bg-white border border-[#1A1A1A]/10 rounded-xl text-[#1A1A1A] font-medium font-serif leading-relaxed">
                                {result.sentences[selectedSentenceIdx].revised}
                              </p>
                            </div>
                          </div>

                          <div className="space-y-2 pt-2 border-t border-[#EAE6DF] text-xs">
                            {result.sentences[selectedSentenceIdx].explanation && (
                              <div className="flex gap-2 items-start">
                                <Info className="w-3.5 h-3.5 text-[#8C857B] shrink-0 mt-0.5" />
                                <span className="text-[11px] text-[#555]">
                                  <strong>Rule:</strong> {result.sentences[selectedSentenceIdx].explanation}
                                </span>
                              </div>
                            )}

                            {result.sentences[selectedSentenceIdx].suggestions && (result.sentences[selectedSentenceIdx].suggestions?.length ?? 0) > 0 && (
                              <div className="space-y-1 pl-5">
                                <span className="text-[9px] uppercase tracking-wider font-bold text-[#8C857B]">Alternatives:</span>
                                <ul className="list-disc list-inside space-y-1 text-[#555] text-[11px]">
                                  {result.sentences[selectedSentenceIdx].suggestions?.map((sug, sIdx) => (
                                    <li key={sIdx}>{sug}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Diagnosis */}
                      <div className="space-y-2 border-t border-[#EAE6DF] pt-4">
                        <span className="text-[9px] uppercase font-bold tracking-wider text-[#8C857B] block">Diagnosis</span>
                        <p className="text-xs text-[#555] bg-slate-50 border border-slate-100 p-3 rounded-xl italic">
                          {result.explanation || "All author structures, paragraph bounds, and footnotes preserved correctly."}
                        </p>
                      </div>

                      {/* Footnotes */}
                      {footnotes.length > 0 && (
                        <div className="space-y-2 border-t border-[#EAE6DF] pt-4">
                          <span className="text-[9px] uppercase font-bold tracking-wider text-[#8C857B] block">Notes & References</span>
                          <div className="space-y-1">
                            {footnotes.map((fn, i) => (
                              <p key={i} className="text-xs text-[#555] font-serif leading-relaxed">
                                {fn.revised}
                              </p>
                            ))}
                          </div>
                        </div>
                      )}

                    </div>
                  )}

                  {activeTab === "suggestions" && (
                    <div className="p-6 space-y-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Zap className="w-4 h-4 text-amber-500" />
                        <h4 className="text-xs uppercase font-extrabold tracking-widest text-[#1a1a1a]">
                          Lexical Diagnostics
                        </h4>
                      </div>

                      <div className="space-y-3">
                        {result.suggestions.map((suggestion, sIdx) => (
                          <div
                            key={sIdx}
                            className="p-3 bg-[#FAF9F6] border border-[#EAE6DF] rounded-xl text-xs text-[#555] flex gap-2"
                          >
                            <span className="text-[#1A1A1A] font-bold">{sIdx + 1}.</span>
                            <p className="leading-relaxed">{suggestion}</p>
                          </div>
                        ))}
                      </div>

                      <div className="text-[10px] p-3 text-[#8C857B] leading-relaxed bg-[#FFF]/80 rounded-xl border border-dashed border-[#EAE6DF] mt-6">
                        These suggestions correspond to domain-level patterns detected in your text. Edit your draft on the left to apply them.
                      </div>
                    </div>
                  )}

                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-[#FAF9F6]/35 rounded-3xl">
                  <div className="w-12 h-12 rounded-2xl bg-[#1A1A1A]/5 flex items-center justify-center mb-4">
                    <Sparkles className="w-6 h-6 text-[#8C857B]" />
                  </div>
                  <h3 className="font-serif text-lg font-bold mb-1">Ready to Nativize</h3>
                  <p className="text-xs text-[#8C857B] max-w-xs leading-relaxed mb-4">
                    Write or paste your text on the left, then hit Nativize to launch voice-preserving refinement.
                  </p>

                  <div className="space-y-2 w-full max-w-xs text-left bg-white p-4 border border-[#EAE6DF] rounded-2xl text-[11px] text-[#555]">
                    <span className="text-[9px] uppercase tracking-wider font-bold text-[#8C857B] block mb-1">What happens:</span>
                    <div className="flex gap-2 items-start">
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5" />
                      <span>Headings and citations preserved exactly</span>
                    </div>
                    <div className="flex gap-2 items-start">
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5" />
                      <span>Your rhythm and voice kept intact</span>
                    </div>
                    <div className="flex gap-2 items-start">
                      <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0 mt-0.5" />
                      <span>Grammar and fluency corrected minimally</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Bottom bar */}
            {result && (
              <div className="px-5 py-3 border-t border-[#EAE6DF] bg-[#FAF9F6] flex items-center justify-between text-[10px] text-[#8C857B]">
                <div className="flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5" />
                  <span>{wordCount(result.finalVersion)} words</span>
                  <span>·</span>
                  <span>{charCount(result.finalVersion)} chars</span>
                </div>
                <div>
                  Dialect: <span className="font-bold text-[#1A1A1A]">{result.detectedDialect || "US"}</span>
                </div>
              </div>
            )}

          </section>

        </div>

        {/* How it works */}
        <section className="bg-white border border-[#EAE6DF] p-4 rounded-3xl space-y-2 mt-4 max-w-4xl">
          <h4 className="text-[10px] uppercase font-bold tracking-wider text-[#1a1a1a] flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5" />
            <span>How IdiomOptima Preserves Your Voice</span>
          </h4>
          <p className="text-xs text-[#555] leading-relaxed">
            Standard checkers rewrite non-native sentences into homogeneous academic styles. IdiomOptima detects
            structural signals such as complex clause alternation, academic hedging like <em>may appear to</em>,
            or interpretive business ambiguity to protect your rhythm while correcting spelling and grammar.
            Headings, citations, and list structures remain strictly safe.
          </p>
        </section>

      </main>

      {/* ─── Footer ─── */}
      <footer className="border-t border-[#EAE6DF] bg-[#FAF9F6] mt-auto">
        <div className="max-w-[1600px] mx-auto px-6 py-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 bg-[#1A1A1A] rounded-lg flex items-center justify-center">
                <Languages className="w-3.5 h-3.5 text-white" />
              </div>
              <div>
                <span className="font-serif text-sm font-bold text-[#1A1A1A]">IdiomOptima</span>
                <p className="text-[9px] text-[#8C857B]">Voice Preservation Engine</p>
              </div>
            </div>

            <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[11px] font-semibold text-[#8C857B]">
              <a href="/faq.html" className="hover:text-[#1A1A1A] transition-colors">FAQ</a>
              <a href="/terms.html" className="hover:text-[#1A1A1A] transition-colors">Terms of Service</a>
              <a href="/privacy.html" className="hover:text-[#1A1A1A] transition-colors">Privacy Policy</a>
              <a href="mailto:contact@IdiomOptima.com" className="hover:text-[#1A1A1A] transition-colors">Contact</a>
            </nav>
          </div>

          <div className="mt-6 pt-4 border-t border-[#EAE6DF] text-center text-[10px] text-[#8C857B]">
            &copy; {new Date().getFullYear()} IdiomOptima. All rights reserved.
          </div>
        </div>
      </footer>

    </div>
  );
}
