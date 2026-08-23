import { useState, useEffect } from "react";
import {
  Sparkles,
  Download,
  RefreshCw,
  Trash2,
  Languages,
  PenLine,
  FileText,
  Info,
  Eye,
  Zap,
  Clipboard,
  Check,
  BookOpen,
  Briefcase,
  Activity,
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
  const [activeTab, setActiveTab] = useState<"result" | "suggestions">("result");

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
    setProgressPhase("Analyzing your text...");

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
          children: [new TextRun({ text: s.revised + " ", font: "Georgia", size: 24 })]
        });
      });
      const doc = new Document({
        sections: [{
          properties: {},
          children: [
            new Paragraph({
              children: [new TextRun({ text: "IdiomOptima Export", bold: true, size: 36, font: "Georgia" })],
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
      console.error("Failed to export PDF:", e);
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
        return { label: "Academic", color: "bg-indigo-50 text-indigo-700 border-indigo-200", icon: <BookOpen className="w-3 h-3" /> };
      case "business":
        return { label: "Business", color: "bg-sky-50 text-sky-700 border-sky-200", icon: <Briefcase className="w-3 h-3" /> };
      case "creative":
        return { label: "Creative", color: "bg-rose-50 text-rose-700 border-rose-200", icon: <Activity className="w-3 h-3" /> };
      default:
        return { label: "General", color: "bg-slate-50 text-slate-600 border-slate-200", icon: <Languages className="w-3 h-3" /> };
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
          if (op === -1) return <span key={i} className="bg-red-100 text-red-700 line-through rounded px-0.5">{text}</span>;
          if (op === 1) return <span key={i} className="bg-emerald-100 text-emerald-700 font-medium rounded px-0.5">{text}</span>;
          return null;
        })}
      </span>
    );
  };

  const HEADING_REGEX = /^(?:#{1,4}\s+)?(?:Chapter|Section|Introduction|Conclusion|Abstract|Summary|Background|Methodology|Results|Discussion|References|Appendix|Acknowledgements|Table of Contents|Literature Review|Problem Statement|Objectives?|Scope|Limitations?|Deliverables?|Timeline|Budget|Recommendations?)\b/i;
  const HEADING_MARKER_REGEX = /^#{1,4}\s+/;

  const tagSentence = (sent: any) => {
    const text = (sent.original || "").trim();
    const words = text.split(/\s+/);
    const isShortLine = words.length <= 8;
    const noTrailingPeriod = !/[.!?]\s*$/.test(text) && !/[.!?]$/.test(text);
    const isHeadingLike = isShortLine && noTrailingPeriod && HEADING_REGEX.test(text);
    const headingMatch = text.match(HEADING_MARKER_REGEX);
    if (headingMatch) return { ...sent, isHeading: true, headingLevel: headingMatch[1].length || 2 };
    if (isHeadingLike) return { ...sent, isHeading: true, headingLevel: 2 };
    return { ...sent, isHeading: false, headingLevel: 0 };
  };

  const taggedSentences = (result?.sentences || []).map(tagSentence);
  const footnotes = taggedSentences.filter(s => s.isImmutableFootnote);
  const bodySentences = taggedSentences.filter(s => !s.isImmutableFootnote);

  return (
    <div className="min-h-screen bg-[#FAF8F5] text-[#1a1a2e] flex flex-col font-sans selection:bg-[#4f46e5]/15 selection:text-[#1a1a2e]">

      {/* ─── Top Bar ─── */}
      <header className="border-b border-[#E5E2DC] bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-6 h-12 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 bg-gradient-to-br from-[#4f46e5] to-[#7c3aed] rounded-lg flex items-center justify-center shadow-sm">
              <Languages className="w-3.5 h-3.5 text-white" />
            </div>
            <h1 className="font-serif text-lg font-bold tracking-tight text-[#1a1a2e]">IdiomOptima</h1>
          </div>
          <div className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold border ${modeInfo.color}`}>
            {modeInfo.icon}
            <span>{modeInfo.label}</span>
          </div>
        </div>
      </header>

      {/* ─── Hero ─── */}
      <section className="relative overflow-hidden border-b border-[#E5E2DC]">
        <div className="absolute inset-0 bg-gradient-to-br from-[#EEF2FF] via-[#FAF8F5] to-[#F5F0FF]" />
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #4f46e5 1px, transparent 0)", backgroundSize: "20px 20px" }} />
        <div className="relative max-w-[1600px] mx-auto px-6 py-8 md:py-10 text-center">
          <h2 className="font-serif text-3xl md:text-4xl lg:text-5xl font-bold text-[#1a1a2e] leading-tight mb-3 tracking-tight">
            Edit. Nativize. Humanize.
          </h2>
          <p className="text-sm md:text-base text-[#64607a] max-w-lg mx-auto leading-relaxed">
            Your voice, preserved. Grammar and fluency refined while protecting your rhythm, headings, and citations.
          </p>
        </div>
      </section>

      {/* ─── Main Tool ─── */}
      <main className="max-w-[1600px] w-full mx-auto px-6 py-6 flex-1 flex flex-col gap-5">

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch flex-1">

          {/* ── Left: Editor ── */}
          <section className="lg:col-span-7 flex flex-col bg-white border border-[#E5E2DC] rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">

            {/* Editor toolbar */}
            <div className="px-4 py-2 border-b border-[#E5E2DC] bg-[#FAF8F5] flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-2 mr-auto">
                <PenLine className="w-3.5 h-3.5 text-[#8C857B]" />
                <span className="text-[10px] uppercase font-bold tracking-wider text-[#8C857B]">
                  {wordCount(plainTextInput)} words
                </span>
              </div>

              <select value={forcedDialect} onChange={(e) => setForcedDialect(e.target.value)}
                className="h-7 text-[10px] font-semibold bg-white border border-[#E5E2DC] rounded-md px-2 text-[#1a1a2e] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#4f46e5]">
                {DIALECTS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
              <select value={domain} onChange={(e) => setDomain(e.target.value)}
                className="h-7 text-[10px] font-semibold bg-white border border-[#E5E2DC] rounded-md px-2 text-[#1a1a2e] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#4f46e5]">
                {DOMAINS.map((dm) => <option key={dm.value} value={dm.value}>{dm.label}</option>)}
              </select>
              <select value={tone} onChange={(e) => setTone(e.target.value)}
                className="h-7 text-[10px] font-semibold bg-white border border-[#E5E2DC] rounded-md px-2 text-[#1a1a2e] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#4f46e5]">
                {TONES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>

              <div className="w-px h-5 bg-[#E5E2DC]" />

              <button onClick={handleClear}
                className="p-1 text-[#8C857B] hover:text-red-500 transition-colors rounded hover:bg-red-50"
                title="Clear">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Editor surface */}
            <div className="flex-1 min-h-[500px] bg-white relative">
              <RichTextEditor content={inputHtml} onChange={setInputHtml} />
            </div>

            {/* Action bar */}
            <div className="px-4 py-3 border-t border-[#E5E2DC] bg-[#FAF8F5] flex items-center justify-between">
              <div className="text-[10px] text-[#8C857B] max-w-xs">
                Paste or write freely. Your voice stays intact.
              </div>
              <button
                onClick={handleTransform}
                disabled={loading || !plainTextInput.trim()}
                className="inline-flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-[#4f46e5] to-[#6366f1] text-white hover:from-[#4338ca] hover:to-[#4f46e5] disabled:from-[#C5C5D2] disabled:to-[#C5C5D2] disabled:cursor-not-allowed rounded-full text-xs font-bold transition-all shadow-sm hover:shadow-md active:scale-95"
              >
                {loading ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Nativizing ({progress}%)</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>Nativize</span>
                  </>
                )}
              </button>
            </div>
          </section>

          {/* ── Right: Output ── */}
          <section className="lg:col-span-5 flex flex-col bg-white border border-[#E5E2DC] rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-shadow">

            {/* Output tabs + tools */}
            <div className="px-4 py-2 border-b border-[#E5E2DC] bg-[#FAF8F5] flex items-center gap-1">
              <button onClick={() => setActiveTab("result")} disabled={!result}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-colors ${
                  activeTab === "result" ? "bg-[#4f46e5] text-white" : "text-[#8C857B] hover:bg-[#E5E2DC]"
                } disabled:opacity-30`}>
                Output
              </button>
              <button onClick={() => setActiveTab("suggestions")} disabled={!result || result.suggestions.length === 0}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-colors ${
                  activeTab === "suggestions" ? "bg-[#4f46e5] text-white" : "text-[#8C857B] hover:bg-[#E5E2DC]"
                } disabled:opacity-30`}>
                Diagnostics
                {result?.suggestions && result.suggestions.length > 0 && (
                  <span className="ml-1.5 px-1 py-0.5 bg-amber-400 text-amber-900 text-[9px] font-black rounded-full">
                    {result.suggestions.length}
                  </span>
                )}
              </button>

              <div className="ml-auto flex items-center gap-1">
                {result && activeTab === "result" && (
                  <button onClick={() => setShowDiff(!showDiff)}
                    className={`text-[10px] px-2 py-1 rounded-md border transition-all font-semibold ${
                      showDiff ? 'bg-[#4f46e5] text-white border-[#4f46e5]' : 'bg-white text-[#8C857B] border-[#E5E2DC] hover:border-[#4f46e5]'
                    }`}>
                    {showDiff ? 'Diff On' : 'Diff'}
                  </button>
                )}
                {result && (
                  <>
                    <button onClick={handleCopy} className="p-1.5 hover:bg-[#E5E2DC] rounded-md text-[#8C857B] hover:text-[#1a1a2e] transition-colors" title="Copy">
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Clipboard className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={exportAsPDF} className="p-1.5 hover:bg-[#E5E2DC] rounded-md text-[#8C857B] hover:text-[#1a1a2e] transition-colors" title="Export PDF">
                      <FileText className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={exportAsWord} className="p-1.5 hover:bg-[#E5E2DC] rounded-md text-[#8C857B] hover:text-[#1a1a2e] transition-colors" title="Export Word">
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Output content */}
            <div className="flex-1 bg-white flex flex-col overflow-y-auto">
              {loading ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                  <div className="relative w-14 h-14 flex items-center justify-center mb-4">
                    <div className="absolute inset-0 border-[3px] border-[#E5E2DC] border-t-[#4f46e5] rounded-full animate-spin" />
                    <Sparkles className="w-5 h-5 text-[#4f46e5]" />
                  </div>
                  <h3 className="font-serif text-lg font-bold mb-1 text-[#1a1a2e]">Preserving your voice</h3>
                  <p className="text-xs text-[#8C857B] mb-4 max-w-xs">{progressPhase}</p>
                  <div className="w-48 h-1.5 bg-[#E5E2DC] rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-[#4f46e5] to-[#6366f1] rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              ) : error ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                  <Info className="w-8 h-8 text-red-400 mb-3" />
                  <h3 className="font-bold text-sm text-red-800 mb-1">Something went wrong</h3>
                  <p className="text-xs text-[#64607a] max-w-sm leading-relaxed mb-4">{error}</p>
                  <button onClick={handleTransform} className="px-4 py-2 bg-red-50 text-red-700 rounded-full font-bold text-xs hover:bg-red-100 transition-colors border border-red-200">
                    Retry
                  </button>
                </div>
              ) : result ? (
                <div className="flex-1 flex flex-col h-full">

                  {activeTab === "result" && (
                    <div className="p-6 space-y-5 flex-1">

                      {/* Score cards */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="p-3 bg-[#FAF8F5] border border-[#E5E2DC] rounded-xl">
                          <span className="text-[9px] uppercase tracking-wider text-[#8C857B] font-bold block mb-0.5">Voice Integrity</span>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-2xl font-serif font-black text-[#1a1a2e]">{result.originalScore}</span>
                            <span className="text-[10px] text-[#8C857B] font-semibold">/ 100</span>
                          </div>
                        </div>
                        <div className="p-3 bg-[#FAF8F5] border border-[#E5E2DC] rounded-xl">
                          <span className="text-[9px] uppercase tracking-wider text-[#8C857B] font-bold block mb-0.5">Fluency Score</span>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-2xl font-serif font-black text-[#1a1a2e]">{result.revisedScore}</span>
                            <span className="text-[10px] text-[#8C857B] font-semibold">/ 100</span>
                          </div>
                        </div>
                      </div>

                      {/* Instruction */}
                      <div className="flex items-center gap-1.5 text-[10px] text-[#8C857B] font-semibold">
                        <Eye className="w-3 h-3" />
                        <span>{showDiff ? 'Word-level diff active' : 'Click any sentence to compare original vs. refined'}</span>
                      </div>

                      {/* Sentence output with paragraph grouping */}
                      <div className="output-prose pl-4 border-l-2 border-[#4f46e5]/20">
                        {(() => {
                          const groups: JSX.Element[] = [];
                          let currentParagraph: JSX.Element[] = [];
                          let pIdx = 0;

                          bodySentences.forEach((sent, idx) => {
                            const text = sent.isNativeMatch ? sent.original : sent.revised;
                            const content = (
                              <span
                                key={idx}
                                title={`Original: ${sent.original}`}
                                onClick={() => setSelectedSentenceIdx(idx)}
                                className={`inline px-0.5 rounded transition-all cursor-pointer ${
                                  selectedSentenceIdx === idx
                                    ? "bg-[#4f46e5]/10 font-medium"
                                    : sent.original !== sent.revised
                                    ? "bg-amber-50 hover:bg-amber-100"
                                    : "hover:bg-slate-50"
                                }`}
                              >
                                {showDiff && !sent.isNativeMatch
                                  ? renderDiff(sent.original, sent.revised)
                                  : text}
                              </span>
                            );

                            if (sent.isHeading) {
                              if (currentParagraph.length > 0) {
                                groups.push(<p key={`p-${pIdx++}`} className="mb-4">{currentParagraph}</p>);
                                currentParagraph = [];
                              }
                              groups.push(
                                <h3 key={`h-${idx}`} className="text-lg font-bold text-[#1a1a2e] mb-2 mt-4 first:mt-0">
                                  {content}
                                </h3>
                              );
                            } else {
                              currentParagraph.push(<span key={`ws-${idx}`}> </span>);
                              currentParagraph.push(content);
                              if (sent.isEndOfParagraph) {
                                groups.push(<p key={`p-${pIdx++}`} className="mb-4">{currentParagraph}</p>);
                                currentParagraph = [];
                              }
                            }
                          });

                          if (currentParagraph.length > 0) {
                            groups.push(<p key={`p-${pIdx}`} className="mb-4">{currentParagraph}</p>);
                          }

                          return groups;
                        })()}
                      </div>

                      {/* Sentence comparison */}
                      {selectedSentenceIdx !== null && (
                        <div className="border border-[#E5E2DC] rounded-xl p-4 bg-[#FAF8F5] space-y-3 transform transition-all duration-200 shadow-sm">
                          <div className="flex items-center justify-between">
                            <span className="text-[9px] uppercase font-bold tracking-widest text-[#8C857B]">
                              Sentence #{selectedSentenceIdx + 1}
                            </span>
                            <span className={`text-[9px] font-bold px-2 py-0.5 rounded ${
                              result.sentences[selectedSentenceIdx].original === result.sentences[selectedSentenceIdx].revised
                                ? "text-slate-600 bg-slate-100"
                                : "text-amber-700 bg-amber-50"
                            }`}>
                              {result.sentences[selectedSentenceIdx].original === result.sentences[selectedSentenceIdx].revised
                                ? "Unchanged" : "Refined"}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-3 text-xs">
                            <div className="space-y-1">
                              <span className="text-[9px] font-bold text-[#8C857B] uppercase">Draft</span>
                              <p className="p-2.5 bg-white border border-[#E5E2DC] rounded-lg text-[#64607a] italic text-[11px] leading-relaxed">
                                {result.sentences[selectedSentenceIdx].original}
                              </p>
                            </div>
                            <div className="space-y-1">
                              <span className="text-[9px] font-bold text-[#8C857B] uppercase">Refined</span>
                              <p className="p-2.5 bg-white border border-[#4f46e5]/20 rounded-lg text-[#1a1a2e] font-medium text-[11px] leading-relaxed">
                                {result.sentences[selectedSentenceIdx].revised}
                              </p>
                            </div>
                          </div>

                          {result.sentences[selectedSentenceIdx].explanation && (
                            <div className="flex gap-2 items-start pt-2 border-t border-[#E5E2DC]">
                              <Info className="w-3 h-3 text-[#4f46e5] shrink-0 mt-0.5" />
                              <span className="text-[10px] text-[#64607a] leading-relaxed">
                                {result.sentences[selectedSentenceIdx].explanation}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Diagnosis */}
                      <div className="border-t border-[#E5E2DC] pt-4">
                        <p className="text-[11px] text-[#8C857B] italic leading-relaxed">
                          {result.explanation || "All structures, paragraph bounds, and footnotes preserved correctly."}
                        </p>
                      </div>

                      {/* Footnotes — visually separated */}
                      {footnotes.length > 0 && (
                        <div className="mt-4 pt-4 border-t-2 border-[#E5E2DC] bg-[#FAF8F5] -mx-6 px-6 pb-0 rounded-b-2xl">
                          <span className="text-[9px] uppercase font-bold tracking-wider text-[#8C857B] block mb-2">Notes & References</span>
                          <div className="space-y-1.5">
                            {footnotes.map((fn, i) => (
                              <p key={i} className="text-xs text-[#64607a] font-serif leading-relaxed pl-4 border-l-2 border-[#E5E2DC]">
                                {fn.revised}
                              </p>
                            ))}
                          </div>
                        </div>
                      )}

                    </div>
                  )}

                  {activeTab === "suggestions" && (
                    <div className="p-6 space-y-3">
                      <div className="flex items-center gap-2 mb-3">
                        <Zap className="w-4 h-4 text-amber-500" />
                        <h4 className="text-xs uppercase font-extrabold tracking-widest text-[#1a1a2e]">Diagnostics</h4>
                      </div>
                      {result.suggestions.map((suggestion, sIdx) => (
                        <div key={sIdx} className="p-3 bg-[#FAF8F5] border border-[#E5E2DC] rounded-xl text-xs text-[#64607a] flex gap-2">
                          <span className="text-[#4f46e5] font-bold shrink-0">{sIdx + 1}.</span>
                          <p className="leading-relaxed">{suggestion}</p>
                        </div>
                      ))}
                    </div>
                  )}

                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-10 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-[#4f46e5]/5 flex items-center justify-center mb-5">
                    <Sparkles className="w-6 h-6 text-[#4f46e5]" />
                  </div>
                  <h3 className="font-serif text-xl font-bold mb-2 text-[#1a1a2e]">Ready to refine</h3>
                  <p className="text-sm text-[#8C857B] max-w-xs leading-relaxed">
                    Write or paste your text on the left, then hit <strong className="text-[#4f46e5]">Nativize</strong>.
                  </p>
                </div>
              )}
            </div>

            {/* Status bar */}
            {result && (
              <div className="px-4 py-2 border-t border-[#E5E2DC] bg-[#FAF8F5] flex items-center justify-between text-[10px] text-[#8C857B]">
                <span>{wordCount(result.finalVersion)} words, {charCount(result.finalVersion)} chars</span>
                <span>Dialect: <strong className="text-[#1a1a2e]">{result.detectedDialect || "US"}</strong></span>
              </div>
            )}

          </section>

        </div>

      </main>

      {/* ─── Footer ─── */}
      <footer className="border-t border-[#E5E2DC] bg-white mt-auto">
        <div className="max-w-[1600px] mx-auto px-6 py-5 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="font-serif text-sm font-bold text-[#1a1a2e]">IdiomOptima</span>
            <span className="text-[10px] text-[#8C857B]">&copy; {new Date().getFullYear()}</span>
          </div>
          <nav className="flex items-center gap-5 text-[11px] font-semibold text-[#8C857B]">
            <a href="/faq.html" className="hover:text-[#4f46e5] transition-colors">FAQ</a>
            <a href="/terms.html" className="hover:text-[#4f46e5] transition-colors">Terms</a>
            <a href="/privacy.html" className="hover:text-[#4f46e5] transition-colors">Privacy</a>
            <a href="mailto:contact@IdiomOptima.com" className="hover:text-[#4f46e5] transition-colors">Contact</a>
          </nav>
        </div>
      </footer>

    </div>
  );
}
