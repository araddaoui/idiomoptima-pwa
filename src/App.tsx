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
  Eye,
  Zap,
  Clipboard,
  Check,
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

      {/* ─── Top Bar ─── */}
      <header className="border-b border-[#EAE6DF] bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#1A1A1A] rounded-lg flex items-center justify-center">
              <Languages className="w-4 h-4 text-white" />
            </div>
            <h1 className="font-serif text-xl font-bold tracking-tight">IdiomOptima</h1>
          </div>
          <div className={`hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold border ${modeInfo.color}`}>
            {modeInfo.icon}
            <span>{modeInfo.label}</span>
          </div>
        </div>
      </header>

      {/* ─── Hero ─── */}
      <section className="relative overflow-hidden border-b border-[#EAE6DF]">
        <div className="absolute inset-0 bg-gradient-to-br from-[#FAF9F6] via-white to-[#F5F0E8]" />
        <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #1A1A1A 1px, transparent 0)", backgroundSize: "24px 24px" }} />
        <div className="relative max-w-[1600px] mx-auto px-6 py-16 md:py-20 text-center">
          <h2 className="font-serif text-5xl md:text-6xl lg:text-7xl font-bold text-[#1A1A1A] leading-[1.05] mb-5 tracking-tight">
            Edit.<br className="hidden sm:block" /> Nativize. Humanize.
          </h2>
          <p className="text-base md:text-lg text-[#8C857B] max-w-xl mx-auto leading-relaxed">
            Your voice, preserved. Grammar, fluency, and native expression refined
            while protecting your rhythm, headings, and citations.
          </p>
        </div>
      </section>

      {/* ─── Main Tool ─── */}
      <main className="max-w-[1600px] w-full mx-auto px-6 py-8 flex-1 flex flex-col gap-6">

        {/* Editor + Output */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch flex-1">

          {/* ── Left: Editor ── */}
          <section className="lg:col-span-7 flex flex-col bg-white border border-[#EAE6DF] rounded-2xl overflow-hidden shadow-sm">

            {/* Editor toolbar: settings + controls inline */}
            <div className="px-4 py-2.5 border-b border-[#EAE6DF] bg-[#FAF9F6] flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2 mr-auto">
                <PenLine className="w-3.5 h-3.5 text-[#8C857B]" />
                <span className="text-[10px] uppercase font-bold tracking-wider text-[#8C857B]">
                  {wordCount(plainTextInput)} words
                </span>
              </div>

              <select
                value={forcedDialect}
                onChange={(e) => setForcedDialect(e.target.value)}
                className="h-7 text-[10px] font-semibold bg-white border border-[#EAE6DF] rounded-md px-2 text-[#1A1A1A] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#1A1A1A]"
              >
                {DIALECTS.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>

              <select
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                className="h-7 text-[10px] font-semibold bg-white border border-[#EAE6DF] rounded-md px-2 text-[#1A1A1A] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#1A1A1A]"
              >
                {DOMAINS.map((dm) => (
                  <option key={dm.value} value={dm.value}>{dm.label}</option>
                ))}
              </select>

              <select
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                className="h-7 text-[10px] font-semibold bg-white border border-[#EAE6DF] rounded-md px-2 text-[#1A1A1A] cursor-pointer focus:outline-none focus:ring-1 focus:ring-[#1A1A1A]"
              >
                {TONES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>

              <div className="w-px h-5 bg-[#EAE6DF]" />

              <button
                onClick={handleClear}
                className="p-1 text-[#8C857B] hover:text-[#DC2626] transition-colors rounded hover:bg-[#F2EFE9]"
                title="Clear"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Editor surface */}
            <div className="flex-1 min-h-[560px] bg-white relative">
              <RichTextEditor
                content={inputHtml}
                onChange={setInputHtml}
              />
            </div>

            {/* Action bar */}
            <div className="px-4 py-3 border-t border-[#EAE6DF] bg-[#FAF9F6] flex items-center justify-between">
              <div className="text-[10px] text-[#8C857B] max-w-xs">
                Paste or write freely. Your voice stays intact.
              </div>
              <button
                onClick={handleTransform}
                disabled={loading || !plainTextInput.trim()}
                className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#1A1A1A] text-white hover:bg-[#333] disabled:bg-[#CCC] disabled:cursor-not-allowed rounded-full text-xs font-bold transition-all shadow-sm hover:shadow-md active:scale-95"
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
          <section className="lg:col-span-5 flex flex-col bg-white border border-[#EAE6DF] rounded-2xl overflow-hidden shadow-sm">

            {/* Output tabs + tools */}
            <div className="px-4 py-2.5 border-b border-[#EAE6DF] bg-[#FAF9F6] flex items-center gap-1">
              <button
                onClick={() => setActiveTab("result")}
                disabled={!result}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-colors ${
                  activeTab === "result" ? "bg-[#1A1A1A] text-white" : "text-[#8C857B] hover:bg-[#EAE6DF]"
                } disabled:opacity-30`}
              >
                Output
              </button>
              <button
                onClick={() => setActiveTab("suggestions")}
                disabled={!result || result.suggestions.length === 0}
                className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded-md transition-colors ${
                  activeTab === "suggestions" ? "bg-[#1A1A1A] text-white" : "text-[#8C857B] hover:bg-[#EAE6DF]"
                } disabled:opacity-30`}
              >
                Diagnostics
                {result?.suggestions && result.suggestions.length > 0 && (
                  <span className="ml-1.5 px-1 py-0.5 bg-[#F2C94C] text-[#333] text-[9px] font-black rounded-full">
                    {result.suggestions.length}
                  </span>
                )}
              </button>

              <div className="ml-auto flex items-center gap-1">
                {result && activeTab === "result" && (
                  <button
                    onClick={() => setShowDiff(!showDiff)}
                    className={`text-[10px] px-2 py-1 rounded-md border transition-all font-semibold ${
                      showDiff
                        ? 'bg-[#1A1A1A] text-white border-[#1A1A1A]'
                        : 'bg-white text-[#8C857B] border-[#EAE6DF] hover:border-[#8C857B]'
                    }`}
                  >
                    {showDiff ? 'Diff On' : 'Diff'}
                  </button>
                )}
                {result && (
                  <>
                    <button onClick={handleCopy} className="p-1.5 hover:bg-[#EAE6DF] rounded-md text-[#555] transition-colors" title="Copy">
                      {copied ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Clipboard className="w-3.5 h-3.5" />}
                    </button>
                    <button onClick={exportAsPDF} className="p-1.5 hover:bg-[#EAE6DF] rounded-md text-[#555] transition-colors" title="Export PDF">
                      <FileText className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={exportAsWord} className="p-1.5 hover:bg-[#EAE6DF] rounded-md text-[#555] transition-colors" title="Export Word">
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
                    <div className="absolute inset-0 border-[3px] border-[#EAE6DF] border-t-[#1A1A1A] rounded-full animate-spin" />
                    <Sparkles className="w-5 h-5 text-[#1A1A1A]" />
                  </div>
                  <h3 className="font-serif text-lg font-bold mb-1">Preserving your voice</h3>
                  <p className="text-xs text-[#8C857B] mb-4 max-w-xs">{progressPhase}</p>
                  <div className="w-48 h-1 bg-[#EAE6DF] rounded-full overflow-hidden">
                    <div className="h-full bg-[#1A1A1A] transition-all duration-300" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              ) : error ? (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                  <Info className="w-8 h-8 text-red-400 mb-3" />
                  <h3 className="font-bold text-sm text-red-800 mb-1">Something went wrong</h3>
                  <p className="text-xs text-[#555] max-w-sm leading-relaxed mb-4">{error}</p>
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
                        <div className="p-3 bg-[#FAF9F6] border border-[#EAE6DF] rounded-xl">
                          <span className="text-[9px] uppercase tracking-wider text-[#8C857B] font-bold block mb-0.5">Voice Integrity</span>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-2xl font-serif font-black">{result.originalScore}</span>
                            <span className="text-[10px] text-[#8C857B] font-semibold">/ 100</span>
                          </div>
                        </div>
                        <div className="p-3 bg-[#FAF9F6] border border-[#EAE6DF] rounded-xl">
                          <span className="text-[9px] uppercase tracking-wider text-[#8C857B] font-bold block mb-0.5">Fluency Score</span>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-2xl font-serif font-black">{result.revisedScore}</span>
                            <span className="text-[10px] text-[#8C857B] font-semibold">/ 100</span>
                          </div>
                        </div>
                      </div>

                      {/* Instruction */}
                      <div className="flex items-center gap-1.5 text-[10px] text-[#8C857B] font-semibold">
                        <Eye className="w-3 h-3" />
                        <span>{showDiff ? 'Word-level diff active' : 'Click any sentence to compare original vs. refined'}</span>
                      </div>

                      {/* Sentence output */}
                      <div className="font-serif text-[17px] leading-[1.75] text-[#1A1A1A] pl-4 border-l-2 border-[#1A1A1A]/10">
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
                                className={`inline px-0.5 rounded transition-all cursor-pointer ${
                                  selectedSentenceIdx === idx
                                    ? "bg-amber-100 font-medium"
                                    : sent.original !== sent.revised
                                    ? "bg-[#FCFBE3]/60 hover:bg-[#FCFBE3]"
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
                                groups.push(<div key={`p-${groupIdx++}`} className="mb-4 last:mb-0">{currentGroup}</div>);
                                currentGroup = [];
                              }
                              groups.push(
                                <div key={`h-${idx}`} className="mb-2 last:mb-0 font-bold">
                                  {content}
                                </div>
                              );
                            } else {
                              currentGroup.push(<span key={`ws-${idx}`}> </span>);
                              currentGroup.push(content);
                              if (sent.isEndOfParagraph) {
                                groups.push(<div key={`p-${groupIdx++}`} className="mb-4 last:mb-0">{currentGroup}</div>);
                                currentGroup = [];
                              }
                            }
                          });

                          if (currentGroup.length > 0) {
                            groups.push(<div key={`p-${groupIdx}`} className="mb-4 last:mb-0">{currentGroup}</div>);
                          }

                          return groups;
                        })()}
                      </div>

                      {/* Sentence comparison */}
                      {selectedSentenceIdx !== null && (
                        <div className="border border-[#EAE6DF] rounded-xl p-4 bg-[#FAF9F6] space-y-3 transform transition-all duration-200">
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
                                ? "Unchanged"
                                : "Refined"}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-3 text-xs">
                            <div className="space-y-1">
                              <span className="text-[9px] font-bold text-[#8C857B] uppercase">Draft</span>
                              <p className="p-2.5 bg-white border border-[#EAE6DF] rounded-lg text-[#666] italic text-[11px] leading-relaxed">
                                {result.sentences[selectedSentenceIdx].original}
                              </p>
                            </div>
                            <div className="space-y-1">
                              <span className="text-[9px] font-bold text-[#8C857B] uppercase">Refined</span>
                              <p className="p-2.5 bg-white border border-[#1A1A1A]/10 rounded-lg text-[#1A1A1A] font-medium text-[11px] leading-relaxed">
                                {result.sentences[selectedSentenceIdx].revised}
                              </p>
                            </div>
                          </div>

                          {result.sentences[selectedSentenceIdx].explanation && (
                            <div className="flex gap-2 items-start pt-2 border-t border-[#EAE6DF]">
                              <Info className="w-3 h-3 text-[#8C857B] shrink-0 mt-0.5" />
                              <span className="text-[10px] text-[#555] leading-relaxed">
                                {result.sentences[selectedSentenceIdx].explanation}
                              </span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Diagnosis */}
                      <div className="border-t border-[#EAE6DF] pt-4">
                        <p className="text-[11px] text-[#8C857B] italic leading-relaxed">
                          {result.explanation || "All structures, paragraph bounds, and footnotes preserved correctly."}
                        </p>
                      </div>

                      {/* Footnotes */}
                      {footnotes.length > 0 && (
                        <div className="border-t border-[#EAE6DF] pt-4">
                          <span className="text-[9px] uppercase font-bold tracking-wider text-[#8C857B] block mb-2">Notes & References</span>
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
                    <div className="p-6 space-y-3">
                      <div className="flex items-center gap-2 mb-3">
                        <Zap className="w-4 h-4 text-amber-500" />
                        <h4 className="text-xs uppercase font-extrabold tracking-widest">Diagnostics</h4>
                      </div>
                      {result.suggestions.map((suggestion, sIdx) => (
                        <div key={sIdx} className="p-3 bg-[#FAF9F6] border border-[#EAE6DF] rounded-xl text-xs text-[#555] flex gap-2">
                          <span className="text-[#1A1A1A] font-bold shrink-0">{sIdx + 1}.</span>
                          <p className="leading-relaxed">{suggestion}</p>
                        </div>
                      ))}
                    </div>
                  )}

                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-10 text-center">
                  <div className="w-14 h-14 rounded-2xl bg-[#1A1A1A]/5 flex items-center justify-center mb-5">
                    <Sparkles className="w-6 h-6 text-[#8C857B]" />
                  </div>
                  <h3 className="font-serif text-xl font-bold mb-2">Ready to refine</h3>
                  <p className="text-sm text-[#8C857B] max-w-xs leading-relaxed">
                    Write or paste your text on the left, then hit <strong className="text-[#1A1A1A]">Nativize</strong>.
                  </p>
                </div>
              )}
            </div>

            {/* Status bar */}
            {result && (
              <div className="px-4 py-2 border-t border-[#EAE6DF] bg-[#FAF9F6] flex items-center justify-between text-[10px] text-[#8C857B]">
                <span>{wordCount(result.finalVersion)} words, {charCount(result.finalVersion)} chars</span>
                <span>Dialect: <strong className="text-[#1A1A1A]">{result.detectedDialect || "US"}</strong></span>
              </div>
            )}

          </section>

        </div>

      </main>

      {/* ─── Footer ─── */}
      <footer className="border-t border-[#EAE6DF] bg-white mt-auto">
        <div className="max-w-[1600px] mx-auto px-6 py-6 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="font-serif text-sm font-bold">IdiomOptima</span>
            <span className="text-[10px] text-[#8C857B]">&copy; {new Date().getFullYear()}</span>
          </div>
          <nav className="flex items-center gap-5 text-[11px] font-semibold text-[#8C857B]">
            <a href="/faq.html" className="hover:text-[#1A1A1A] transition-colors">FAQ</a>
            <a href="/terms.html" className="hover:text-[#1A1A1A] transition-colors">Terms</a>
            <a href="/privacy.html" className="hover:text-[#1A1A1A] transition-colors">Privacy</a>
            <a href="mailto:contact@IdiomOptima.com" className="hover:text-[#1A1A1A] transition-colors">Contact</a>
          </nav>
        </div>
      </footer>

    </div>
  );
}
