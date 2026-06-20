/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import ReactMarkdown from "react-markdown";
import { 
  PenLine, 
  Sparkles, 
  Copy, 
  Check, 
  RotateCcw, 
  ChevronRight, 
  Info, 
  History as HistoryIcon,
  Trash2,
  Languages,
  FileText,
  Download,
  ExternalLink,
  Loader2,
  Plus,
  Lightbulb,
  UserCheck,
  Zap,
  Database,
  Search,
  Activity,
  BookOpen,
  Briefcase,
  Shield,
  Tag,
  Mail
} from "lucide-react";
import { Document, Packer, Paragraph, TextRun, FootnoteReferenceRun, PageBreak } from "docx";
import { jsPDF } from "jspdf";
import { saveAs } from "file-saver";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { transformText, TransformationResult } from "@/src/services/geminiService";
import { RichTextEditor } from "./components/RichTextEditor";
import { Analytics } from "@vercel/analytics/react";

const DOMAINS = [
  { value: "general", label: "General", description: "Everyday communication" },
  { value: "academic", label: "Academic", description: "Formal, precise, hedged" },
  { value: "business", label: "Business", description: "Concise, direct, professional" },
  { value: "creative", label: "Creative", description: "Expressive, varied, evocative" },
];

const TONES = [
  { value: "neutral", label: "Neutral" },
  { value: "formal", label: "Formal" },
  { value: "informal", label: "Informal" },
  { value: "persuasive", label: "Persuasive" },
  { value: "empathetic", label: "Empathetic" },
];

interface HistoryItem extends TransformationResult {
  id: string;
  originalText: string;
  domain: string;
  tone: string;
  mode: string;
  timestamp: number;
}

import * as mammoth from "mammoth";
import * as pdfjs from "pdfjs-dist";

// Set worker source for pdfjs
pdfjs.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js`;

export default function App() {
  const [inputText, setInputText] = useState("");
  const [inputHtml, setInputHtml] = useState("");
  const [isReading, setIsReading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputSectionRef = useRef<HTMLDivElement>(null);

  // --- Consent state ---
  const [consentGiven, setConsentGiven] = useState(() => {
    return localStorage.getItem('IdiomOptima_consent') === 'true';
  });

  // --- Usage limits ---
  const DAILY_LIMIT = 4;
  const MAX_WORDS = 800;
  const [remainingUses, setRemainingUses] = useState<number | null>(null);
    const [demoShown, setDemoShown] = useState(false);

  // Load daily usage from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('IdiomOptima_usage');
    const today = new Date().toDateString();
    if (stored) {
      const data = JSON.parse(stored);
      if (data.date === today) {
        setRemainingUses(DAILY_LIMIT - data.count);
      } else {
        localStorage.setItem('IdiomOptima_usage', JSON.stringify({ date: today, count: 0 }));
        setRemainingUses(DAILY_LIMIT);
      }
    } else {
      localStorage.setItem('IdiomOptima_usage', JSON.stringify({ date: today, count: 0 }));
      setRemainingUses(DAILY_LIMIT);
    }
  }, []);
    // Load daily usage from localStorage
  useEffect(() => {
    // ... existing code ...
  }, []);

  // Demo on first load
useEffect(() => {
  if (!demoShown && !inputText.trim()) {
    const example = "The results of the experiment demonstrates that there is a significant correlation between the variables, however further research is needed to establish causality.[1]";
    setInputText(example);
    setInputHtml(example);
    setDemoShown(true);
    setTimeout(() => handleTransform(), 100);
  }
}, [demoShown, inputText]);
  const [idiomDatabase, setIdiomDatabase] = useState<any[]>([]);

  useEffect(() => {
fetch('/idioms-clunky-native.json')
      .then(response => response.json())
      .then(data => {
        setIdiomDatabase(data);
        console.log(`Loaded ${data.length} idioms from database`);
      })
      .catch(error => console.error('Failed to load idiom database:', error));
  }, []);
  const [aiPhraseMap, setAiPhraseMap] = useState<any[]>([]);

useEffect(() => {
  fetch('/ai-natural-database.json')
    .then(response => response.json())
    .then(data => {
      setAiPhraseMap(data);
      console.log(`Loaded ${data.length} AI phrases from database`);
    })
    .catch(error => console.error('Failed to load AI phrase database:', error));
}, []);
    // Apply idiom replacements to text
  const applyIdiomReplacements = (text: string) => {
    let result = text;
    if (idiomDatabase && idiomDatabase.length > 0) {
      idiomDatabase.forEach(entry => {
        if (entry.clunky && result.toLowerCase().includes(entry.clunky.toLowerCase())) {
          const regex = new RegExp(entry.clunky, 'gi');
          result = result.replace(regex, entry.native);
        }
      });
    }
    return result;
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const fileType = file.name.split('.').pop()?.toLowerCase();
    
if (fileType !== 'docx') {
  toast.error("IdiomOptima currently supports Word documents only. For PDFs, copy and paste the text directly.");
  return;
}

    setIsReading(true);
    try {
      if (fileType === 'docx') {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer });
        
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = result.value;
        
        // Wrap superscripts in brackets if they aren't already, so our detection regex catches them
        tempDiv.querySelectorAll('sup').forEach(sup => {
          const content = sup.innerText.trim();
          if (content && /^\d+$/.test(content)) {
            sup.innerText = `[${content}]`;
          }
        });
        
        const text = tempDiv.innerText || tempDiv.textContent || "";
        setInputHtml(result.value);
        setInputText(text);
        toast.success("Word document loaded (with footnotes).");
      } else if (fileType === 'pdf') {
        const arrayBuffer = await file.arrayBuffer();
        const loadingTask = pdfjs.getDocument({ data: arrayBuffer });
        const pdf = await loadingTask.promise;
        let fullText = "";
        
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          // Smarter joining to preserve numbers at line starts
          const pageText = textContent.items
            .map((item: any) => item.str)
            .join(" ")
            .replace(/\s{2,}/g, " "); // Clean up extra spaces
          fullText += pageText + "\n\n";
        }
        
        setInputHtml(fullText.trim().split('\n\n').map(p => `<p>${p}</p>`).join(''));
        setInputText(fullText.trim());
        toast.success("PDF document loaded.");
      }
    } catch (error) {
      console.error("Error reading file:", error);
      toast.error("Failed to read the document. It might be corrupted.");
    } finally {
      setIsReading(false);
      if (event.target) event.target.value = "";
    }
  };
  const [domain, setDomain] = useState("general");
  const [tone, setTone] = useState("neutral");
  const [mode, setMode] = useState("auto");
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<TransformationResult | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [copied, setCopied] = useState(false);

  const htmlToBracketedText = (html: string) => {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = html;
    
    // Convert <sup>1</sup> to [1]
    tempDiv.querySelectorAll('sup').forEach(sup => {
      const content = sup.innerText.trim();
      if (content && /^\d+$/.test(content)) {
        sup.innerText = `[${content}]`;
      }
    });
    
    // Ensure paragraphs are separated by newlines
    tempDiv.querySelectorAll('p').forEach(p => {
      p.appendChild(document.createTextNode('\n\n'));
    });

    return tempDiv.innerText || tempDiv.textContent || "";
  };

  const handleEditorChange = (html: string) => {
    setInputHtml(html);
    const text = htmlToBracketedText(html);
    setInputText(text);
  };

  const [swappedSentenceIndices, setSwappedSentenceIndices] = useState<number[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");

  const [progress, setProgress] = useState(0);
  const [processingStatus, setProcessingStatus] = useState("");
  const [forcedDialect, setForcedDialect] = useState<string | undefined>(undefined);
  const [showDiff, setShowDiff] = useState(false);

  const footnoteRefs = useRef<Record<string, HTMLSpanElement | null>>({});

  const FOOTNOTE_DEF_REGEX = /^\s*(?:\[?(\d{1,3})\]?[\s.:)\-|]{1,3}|Footnote\s*(\d{1,3}))[\s.:)\-|]*\s*(.+)/i;
  const FOOTNOTE_MARKER_REGEX = /\[(\d{1,3})\]|\((\d{1,3})\)|([¹²³⁴⁵⁶⁷⁸⁹⁰])/gu;

  const SUPER_TO_NUM: Record<string, string> = {
    '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5',
    '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁰': '0'
  };

  const getMarkerNum = (match: RegExpExecArray) => {
    return match[1] || match[2] || SUPER_TO_NUM[match[3]];
  };

  const footnoteMap = useMemo(() => {
    const map: Record<string, string> = {};
    if (!inputText) return map;
    
    // Pass 1: Original input text
    const lines = inputText.split(/\r?\n/);
    let currentNum: string | null = null;
    let currentContent: string[] = [];

    const saveCurrent = () => {
      if (currentNum && currentContent.length > 0) {
        const text = currentContent.join(' ').replace(/\s+/g, ' ').trim();
        if (text) map[currentNum] = text;
      }
    };

    lines.forEach(line => {
      const match = line.match(FOOTNOTE_DEF_REGEX);
      if (match) {
        saveCurrent();
        currentNum = match[1] || match[2];
        currentContent = [match[3]?.trim() || ""];
      } else if (currentNum && line.trim()) {
        currentContent.push(line.trim());
      } else if (line.trim() === "" && currentNum) {
        saveCurrent();
        currentNum = null;
      }
    });
    saveCurrent();

    // Pass 2: Result sentences (AI often extracts or refines footnotes)
    if (result && result.sentences) {
      result.sentences.forEach((sent, idx) => {
        const text = swappedSentenceIndices.includes(idx) ? sent.original : sent.native;
        const match = text.trim().match(FOOTNOTE_DEF_REGEX);
        
        if (match) {
          const num = match[1] || match[2];
          const content = match[3]?.trim();
          if (num && content) {
            // Keep the longer version if multiple definitions exist
            if (!map[num] || map[num].length < content.length) {
              map[num] = content;
            }
          }
        } else if (sent.isImmutableFootnote) {
          // If the AI explicitly marked it as immutable footnote but doesn't match our regex,
          // it might be a bibliography entry or multi-line continuation.
          // We don't necessarily map these to numeric IDs unless they match the regex,
          // but we will use the flag to hide them from the body.
        }
      });
    }

    return map;
  }, [inputText, result, swappedSentenceIndices]);

  const footnoteStats = useMemo(() => {
    if (!inputText) return { markerCount: 0, defCount: 0 };
    // Use a fresh regex to avoid state issues
    const markerMatches = inputText.match(new RegExp(FOOTNOTE_MARKER_REGEX.source, 'gu'));
    const markerCount = markerMatches ? markerMatches.length : 0;
    const defCount = Object.keys(footnoteMap).length;
    return { markerCount, defCount };
  }, [inputText, footnoteMap]);

  const wordCount = useMemo(() => {
    if (!inputText) return 0;
    return inputText.trim().split(/\s+/).length;
  }, [inputText]);

  const scrollToFootnote = (id: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const element = footnoteRefs.current[id];
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element.classList.add('bg-blue-100', 'ring-4', 'ring-blue-300', 'transition-all');
      setTimeout(() => element.classList.remove('bg-blue-100', 'ring-4', 'ring-blue-300'), 2500);
    }
  };

const renderDiff = (original: string, native: string) => {
  try {
    const originalWords = original.split(/(\s+)/);
    const nativeWords = native.split(/(\s+)/);
    const result: JSX.Element[] = [];
    let i = 0;
    let j = 0;
    while (i < originalWords.length || j < nativeWords.length) {
      const origWord = originalWords[i] || "";
      const nativeWord = nativeWords[j] || "";
      if (origWord === nativeWord) {
        result.push(<span key={`same-${i}`}>{nativeWord}</span>);
        i++;
        j++;
      } else {
        if (origWord && origWord.trim()) {
          result.push(
            <span key={`del-${i}`} className="bg-red-100 text-red-700 line-through rounded px-0.5 mx-0.5">{origWord}</span>
          );
        }
        if (nativeWord && nativeWord.trim()) {
          result.push(
            <span key={`add-${j}`} className="bg-green-100 text-green-700 font-medium rounded px-0.5 mx-0.5">{nativeWord}</span>
          );
        }
        i++;
        j++;
      }
    }
    return <span>{result}</span>;
  } catch (err) {
    console.error("Diff error:", err);
    return <span>{native}</span>;
  }
};

const renderContentWithFootnotes = (text: string) => {
  if (!text) return null;
    
    // Quick check: if no markers, just render text or markdown if needed
    const markerRegex = new RegExp(FOOTNOTE_MARKER_REGEX.source, 'gu');
    const hasMarkers = /\[\d+\]|\(\d+\)|[¹²³⁴⁵⁶⁷⁸⁹⁰]/.test(text) || (text.match(markerRegex)?.length || 0) > 0;
    
    if (!hasMarkers) {
      if (text.length > 800) {
        return <div className="whitespace-pre-wrap leading-relaxed min-h-[1.6em]">{text}</div>;
      }
      return text;
    }

    markerRegex.lastIndex = 0; 
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = markerRegex.exec(text)) !== null) {
      const before = text.substring(lastIndex, match.index);
      if (before) {
        parts.push(<span key={`text-${lastIndex}`} className="whitespace-pre-wrap">{before}</span>);
      }

      const num = getMarkerNum(match);
      const content = num ? footnoteMap[num] : null;

      parts.push(
        <span key={`marker-${match.index}`} className="group/marker relative inline-flex items-baseline mx-0.5" id={num ? `ref-${num}` : undefined}>
          <button
            onClick={(e) => scrollToFootnote(num, e)}
            className="bg-blue-600 text-white font-bold px-1.5 py-0 rounded text-[9px] translate-y-[-0.3em] hover:bg-blue-700 transition-colors shadow-sm select-none"
          >
            {num}
          </button>
          {content && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 opacity-0 group-hover/marker:opacity-100 transition-all bg-white border-2 border-blue-600 p-4 rounded-xl text-xs shadow-2xl w-80 z-[200] pointer-events-none transform translate-y-1 group-hover/marker:translate-y-0 text-left">
              <div className="font-bold text-blue-600 border-b border-blue-50 pb-2 mb-2 flex items-center gap-2">
                <Info className="w-4 h-4" /> REFERENCE {num}
              </div>
              <div className="text-[#333] leading-relaxed font-serif overflow-auto max-h-40">
                 {content}
              </div>
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-[10px] border-transparent border-t-blue-600" />
            </div>
          )}
        </span>
      );
      lastIndex = markerRegex.lastIndex;
    }

    const remaining = text.substring(lastIndex);
    if (remaining) {
      if (remaining.length < 1000 && /[*_~\[]/.test(remaining)) {
        parts.push(<ReactMarkdown key={`rem-${lastIndex}`} components={{ p: ({children}) => <span className="inline">{children}</span> }}>{remaining}</ReactMarkdown>);
      } else {
        parts.push(<span key={`rem-${lastIndex}`} className="whitespace-pre-wrap">{remaining}</span>);
      }
    }

    return parts;
  };

  const sharedInputStyles: React.CSSProperties = {
    lineHeight: '1.75',
    fontFamily: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
    fontVariantNumeric: 'tabular-nums',
    padding: '24px',
    fontSize: '1.125rem',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    boxSizing: 'border-box',
    border: 'none',
    boxShadow: 'none',
  };

  const handleTransform = async () => {
    if (!inputText.trim()) {
      toast.error("Please enter some text to transform.");
      return;
    }

    // Word limit check
    if (wordCount > MAX_WORDS) {
      toast.error(`Your text exceeds the maximum allowed length (${MAX_WORDS} words). Please shorten it.`);
      return;
    }

    // Daily limit check
    if (remainingUses !== null && remainingUses <= 0) {
      toast.error(`You've reached the daily limit of ${DAILY_LIMIT} transformations. Please try again tomorrow.`);
      return;
    }

    setIsLoading(true);
    setResult(null);
    setSwappedSentenceIndices([]);
    setProgress(0);
    setProcessingStatus("Initializing...");

    try {
      // Apply idiom replacements before sending to worker
      const processedText = applyIdiomReplacements(inputText);

const data = await transformText(
  processedText, 
  domain, 
  tone, 
  (p, current, total, extraStatus) => {
    setProgress(p);
    let status = total > 1 ? `Processing section ${current + 1} of ${total}...` : "Nativizing text...";
    if (extraStatus) status = extraStatus;
    setProcessingStatus(status);
  }, 
  forcedDialect, 
  mode,
  idiomDatabase,
  aiPhraseMap
);

      // Final synchronization heartbeat
      setProgress(100);
      setProcessingStatus("Polishing final prose...");
      await new Promise(resolve => setTimeout(resolve, 300));

      setResult(data);
      
      // Lock dialect if it was auto-detected
      if (data.detectedDialect) {
        setForcedDialect(data.detectedDialect);
      }
      
      const newHistoryItem: HistoryItem = {
        ...data,
        id: crypto.randomUUID(),
        originalText: inputText,
        domain,
        tone,
        mode,
        timestamp: Date.now(),
      };
      setHistory(prev => [newHistoryItem, ...prev].slice(0, 10));
      toast.success("Text transformed successfully!");

      // Update usage count after successful transformation
      const today = new Date().toDateString();
      const stored = localStorage.getItem('IdiomOptima_usage');
      let newCount = 1;
      if (stored) {
        const usage = JSON.parse(stored);
        if (usage.date === today) {
          newCount = usage.count + 1;
        }
      }
      localStorage.setItem('IdiomOptima_usage', JSON.stringify({ date: today, count: newCount }));
      setRemainingUses(DAILY_LIMIT - newCount);

    } catch (error: any) {
      console.error("Transformation failed:", error);
      toast.error(`Transformation failed: ${error.message || "Unknown error"}`);
    } finally {
      setIsLoading(false);
      setProgress(0);
      setProcessingStatus("");
    }
  };

const copyToClipboard = () => {
  if (!result) return;
  const textToCopy = result.finalVersion;
  navigator.clipboard.writeText(textToCopy);
  setCopied(true);
  toast.success("Copied to clipboard!");
  setTimeout(() => setCopied(false), 2000);
};

  const getVisibleText = () => {
    if (!result) return "";
    if (result.sentences && result.sentences.length > 0) {
      const bodyParts: string[] = [];
      let currentPara: string[] = [];

      result.sentences.forEach((sent, idx) => {
        const text = swappedSentenceIndices.includes(idx) ? sent.original : sent.native;
        
        const defMatch = text.trim().match(FOOTNOTE_DEF_REGEX);
        const isFootnoteDef = (!sent.isHeading && !!defMatch) || sent.isImmutableFootnote;
        const isReferencesHeading = sent.isHeading && (
          text.toLowerCase() === "references" || 
          text.toLowerCase() === "bibliography" || 
          text.toLowerCase() === "footnotes"
        );
        
        if (isFootnoteDef || isReferencesHeading) return;

        if (sent.isHeading) {
          if (currentPara.length > 0) {
            bodyParts.push(currentPara.join(" ") + "\n\n");
            currentPara = [];
          }
          bodyParts.push(text + "\n\n");
        } else {
          currentPara.push(text);
          if (sent.isEndOfParagraph) {
            bodyParts.push(currentPara.join(" ") + "\n\n");
            currentPara = [];
          }
        }
      });

      if (currentPara.length > 0) {
        bodyParts.push(currentPara.join(" "));
      }

      let final = bodyParts.join("").trim();
      
      const footnoteItems = Object.entries(footnoteMap).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
      if (footnoteItems.length > 0) {
        final += "\n\n" + "=".repeat(30) + "\nREFERENCES & FOOTNOTES\n" + "-".repeat(30) + "\n\n";
        footnoteItems.forEach(([num, content]) => {
          final += `[${num}] ${content}\n\n`;
        });
      }
      return final;
    }
    return result.finalVersion;
  };

  const exportToWord = async () => {
    if (!result) return;
    try {
      const footnoteIdMap: Record<string, number> = {};
      const sortedNums = Object.keys(footnoteMap).sort((a, b) => parseInt(a) - parseInt(b));
      sortedNums.forEach((num, index) => {
        footnoteIdMap[num] = index + 1;
      });

      const doc = new Document({
        footnotes: Object.entries(footnoteMap).reduce((acc, [num, content]) => {
          const id = footnoteIdMap[num];
          if (id) {
            acc[id] = {
              children: [new Paragraph({
                children: [
                  new TextRun({ text: content, font: "Arial", size: 20 })
                ],
                spacing: { after: 120 },
                indent: { start: 720, hanging: 360 },
              })]
            };
          }
          return acc;
        }, {} as Record<number, any>),
        sections: [{
          children: result.sentences && result.sentences.length > 0
            ? (() => {
                const paragraphs: Paragraph[] = [];
                let currentParagraphChildren: any[] = [];

                const superToNum: Record<string, string> = {
                  '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5',
                  '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁰': '0'
                };

                result.sentences.forEach((sent, idx) => {
                  const text = swappedSentenceIndices.includes(idx) ? sent.original : sent.native;
                  
                  const defMatch = text.trim().match(FOOTNOTE_DEF_REGEX);
                  const isFootnoteDef = (!sent.isHeading && !!defMatch) || sent.isImmutableFootnote;
                  const isReferencesHeading = sent.isHeading && (
                    text.toLowerCase() === "references" || 
                    text.toLowerCase() === "bibliography" || 
                    text.toLowerCase() === "footnotes"
                  );
                  
                  if (isFootnoteDef || isReferencesHeading) return;

                  if (sent.isHeading) {
                    if (currentParagraphChildren.length > 0) {
                      paragraphs.push(new Paragraph({
                        children: [...currentParagraphChildren],
                        spacing: { line: 276, after: 200 },
                      }));
                      currentParagraphChildren = [];
                    }
                    paragraphs.push(new Paragraph({
                      children: [new TextRun({ text: text, font: "Arial", size: 28, bold: true })],
                      spacing: { before: 400, after: 200 },
                    }));
                  } else {
                    const markerRegex = new RegExp(FOOTNOTE_MARKER_REGEX.source, 'gu');
                    let lastIdx = 0;
                    let match;
                    const cleanText = text;
                    
                    while ((match = markerRegex.exec(cleanText)) !== null) {
                      const before = cleanText.substring(lastIdx, match.index);
                      if (before) {
                        currentParagraphChildren.push(new TextRun({ text: before, font: "Arial", size: 24 }));
                      }

                      const numStr = match[1] || match[2] || superToNum[match[3]];
                      const id = footnoteIdMap[numStr];
                      
                      if (id) {
                        currentParagraphChildren.push(new FootnoteReferenceRun(id));
                      } else {
                        currentParagraphChildren.push(new TextRun({ text: match[0], font: "Arial", size: 24, superScript: true }));
                      }
                      lastIdx = markerRegex.lastIndex;
                    }

                    const remaining = cleanText.substring(lastIdx);
                    if (remaining) {
                      currentParagraphChildren.push(new TextRun({ text: remaining, font: "Arial", size: 24 }));
                    }

                    if (sent.isEndOfParagraph || idx === result.sentences.length - 1) {
                      if (currentParagraphChildren.length > 0) {
                        paragraphs.push(new Paragraph({
                          children: [...currentParagraphChildren],
                          spacing: { line: 276, after: 200 },
                        }));
                        currentParagraphChildren = [];
                      }
                    } else if (!sent.isEndOfParagraph) {
                      currentParagraphChildren.push(new TextRun({ text: " " }));
                    }
                  }
                });

                return paragraphs;
              })()
            : [
                new Paragraph({
                  children: [new TextRun({ text: result.finalVersion, font: "Arial", size: 24 })],
                  spacing: { line: 276 },
                }),
              ],
        }],
      } as any);

      const blob = await Packer.toBlob(doc);
      const date = new Date().toISOString().split('T')[0];
      saveAs(blob, `IdiomOptima_Document_${date}.docx`);
      toast.success("Word document exported!");
    } catch (error) {
      console.error("Docx Export Error:", error);
      toast.error("Failed to export Word document.");
    }
  };

  const exportToPDF = () => {
    if (!result) return;
    try {
      const doc = new jsPDF();
      const date = new Date().toISOString().split('T')[0];
      
      const margin = 20;
      const pageWidth = doc.internal.pageSize.width;
      const maxWidth = pageWidth - (margin * 2);
      let currentY = margin + 10;
      
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);

      if (result.sentences && result.sentences.length > 0) {
        let currentParaText = "";
        
        result.sentences.forEach((sent, idx) => {
          const text = swappedSentenceIndices.includes(idx) ? sent.original : sent.native;
          
          const defMatch = text.trim().match(FOOTNOTE_DEF_REGEX);
          const isFootnoteDef = (!sent.isHeading && !!defMatch) || sent.isImmutableFootnote;
          const isReferencesHeading = sent.isHeading && (
            text.toLowerCase() === "references" || 
            text.toLowerCase() === "bibliography" || 
            text.toLowerCase() === "footnotes"
          );
          
          if (isFootnoteDef || isReferencesHeading) {
            // Flush current paragraph first
            if (currentParaText.trim()) {
              const lines = doc.splitTextToSize(currentParaText.trim(), maxWidth);
              doc.text(lines, margin, currentY);
              currentY += (lines.length * 6) + 5;
              currentParaText = "";
            }
            return;
          }

          if (sent.isHeading) {
            // Flush current paragraph
            if (currentParaText.trim()) {
              const lines = doc.splitTextToSize(currentParaText.trim(), maxWidth);
              doc.text(lines, margin, currentY);
              currentY += (lines.length * 6) + 5;
              currentParaText = "";
            }

            // Check page break
            if (currentY > 270) { doc.addPage(); currentY = margin + 10; }

            doc.setFont("helvetica", "bold");
            doc.setFontSize(14);
            const lines = doc.splitTextToSize(text, maxWidth);
            doc.text(lines, margin, currentY);
            currentY += (lines.length * 8) + 5;
            doc.setFont("helvetica", "normal");
            doc.setFontSize(11);
          } else {
            currentParaText += text + " ";
            
            if (sent.isEndOfParagraph || idx === result.sentences.length - 1) {
              // Flush paragraph
              const lines = doc.splitTextToSize(currentParaText.trim(), maxWidth);
              
              // Check if we need a new page for this paragraph
              if (currentY + (lines.length * 6) > 280) {
                doc.addPage();
                currentY = margin + 10;
              }
              
              doc.text(lines, margin, currentY);
              currentY += (lines.length * 6) + 8;
              currentParaText = "";
            }
          }
        });

        // Add physical footnotes section to PDF using the centralized map
        const footnoteEntries = Object.entries(footnoteMap).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));

        if (footnoteEntries.length > 0) {
          if (currentY + 20 > 280) { doc.addPage(); currentY = margin + 10; }
          currentY += 10;
          doc.setFont("helvetica", "bold");
          doc.setFontSize(12);
          doc.text("NOTES & REFERENCES", margin, currentY);
          currentY += 8;
          doc.setFont("helvetica", "italic");
          doc.setFontSize(9);
          
          footnoteEntries.forEach(([num, content]) => {
            const lines = doc.splitTextToSize(`[${num}] ${content}`, maxWidth);
            if (currentY + (lines.length * 5) > 280) { doc.addPage(); currentY = margin + 10; }
            doc.text(lines, margin, currentY);
            currentY += (lines.length * 5) + 3;
          });
        }
      } else {
        const lines = doc.splitTextToSize(result.finalVersion, maxWidth);
        doc.text(lines, margin, currentY);
      }
      
      doc.save(`IdiomOptima_Document_${date}.pdf`);
      toast.success("PDF document exported!");
    } catch (error) {
      console.error(error);
      toast.error("Failed to export PDF.");
    }
  };

  const reset = () => {
    setInputText("");
    setInputHtml("");
    setResult(null);
    setDomain("general");
    setTone("neutral");
    setMode("auto");
  };

  const loadFromHistory = (item: HistoryItem) => {
    setInputText(item.originalText);
    setDomain(item.domain);
    setTone(item.tone);
    setMode(item.mode || "line-edit");
    setResult({
      finalVersion: item.finalVersion,
      sentences: item.sentences || [],
      suggestions: item.suggestions,
      explanation: item.explanation,
      originalScore: item.originalScore,
      revisedScore: item.revisedScore,
    });
    setSwappedSentenceIndices([]);
    setShowHistory(false);
    toast.info("Loaded from history");
  };

  const clearHistory = () => {
    setHistory([]);
    toast.info("History cleared");
  };

  const scrollToInput = () => {
    inputSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const startEdit = (idx: number, currentText: string) => {
    setEditingIndex(idx);
    setEditValue(currentText);
  };
  const saveEdit = (idx: number) => {
    if (!result || !result.sentences) return;
    const newSentences = [...result.sentences];
    newSentences[idx] = { ...newSentences[idx], native: editValue };
    setResult({ ...result, sentences: newSentences });
    setEditingIndex(null);
    setEditValue("");
    toast.success("Sentence updated");
  };
  const handleKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key === 'Enter') saveEdit(idx);
    if (e.key === 'Escape') setEditingIndex(null);
  };

  return (
    <div className="min-h-screen bg-[#FDFCFB] text-[#1A1A1A] font-sans selection:bg-[#E6E6E6]">
      <Toaster position="top-center" />
      <Analytics />
      
      {/* Header */}
      <header className="border-b border-[#E5E5E5] bg-white/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-8 py-3">
          {/* Top row: Logo (left) + Buttons (right) */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 sm:w-12 sm:h-12 bg-gradient-to-br from-[#1E3A8A] to-[#0F172A] rounded-2xl flex items-center justify-center shadow-lg">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white sm:w-6 sm:h-6">
                  <circle cx="12" cy="12" r="10"/>
                  <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>
                  <path d="M2 12h20"/>
                </svg>
              </div>
              <h1 className="font-serif text-3xl sm:text-5xl md:text-6xl font-bold tracking-tight bg-gradient-to-r from-[#1E3A8A] to-[#2563EB] bg-clip-text text-transparent">
                IdiomOptima
              </h1>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="ghost" size="sm" onClick={() => setShowHistory(!showHistory)} className="text-[#666] hover:text-[#1A1A1A] text-xs sm:text-sm">
                <HistoryIcon className="w-3 h-3 sm:w-4 sm:h-4 mr-1" /> History
              </Button>
              <Button variant="outline" size="sm" onClick={reset} className="text-xs sm:text-sm">
                <RotateCcw className="w-3 h-3 sm:w-4 sm:h-4 mr-1" /> Reset
              </Button>
              <Button variant="ghost" size="sm" className="text-[#666] border border-[#E5E5E5] rounded-full text-xs sm:text-sm">Sign in</Button>
              <Button size="sm" className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#333] text-xs sm:text-sm">Sign up</Button>
            </div>
          </div>
          {/* Three words - CENTERED under logo */}
          <div className="flex justify-center mt-6">
            <div className="text-2xl sm:text-3xl md:text-4xl font-medium tracking-wide">
              <span style={{ color: "#3B82F6" }}>Edit.</span>{' '}
              <span style={{ color: "#10B981" }}>Nativize.</span>{' '}
              <span style={{ color: "#F59E0B" }}>Humanize.</span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-8">

        {/* Try a sample chips */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="text-xs text-gray-400">Try a sample:</span>
          <button onClick={() => {
            const example = "The results of the experiment demonstrates that there is a significant correlation between the variables, however further research is needed to establish causality.[1]";
            setInputText(example);
            setInputHtml(example);
            toast.info("Academic example loaded");
          }} className="px-3 py-1.5 text-xs rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200">🎓 Academic</button>
          <button onClick={() => {
            const example = "Please find attached the quarterly report. We need to discuss about the budget allocation for next quarter.";
            setInputText(example);
            setInputHtml(example);
            toast.info("Business example loaded");
          }} className="px-3 py-1.5 text-xs rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200">💼 Business</button>
          <button onClick={() => {
            const example = "The old house stood on the hill, its windows like empty eyes.";
            setInputText(example);
            setInputHtml(example);
            toast.info("Creative example loaded");
          }} className="px-3 py-1.5 text-xs rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200">✍️ Creative</button>
          <button onClick={() => {
            const example = "I am writing to apply for the marketing position. I have 5 years of experience.";
            setInputText(example);
            setInputHtml(example);
            toast.info("Professional example loaded");
          }} className="px-3 py-1.5 text-xs rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200">📧 Professional</button>
          <button onClick={() => {
            const example = "Yesterday I go to the store and buy some apples, but I forget my wallet.";
            setInputText(example);
            setInputHtml(example);
            toast.info("ELL example loaded");
          }} className="px-3 py-1.5 text-xs rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200">🌍 ELL</button>
        </div>

        {/* Control Row - Dialect, Domain, Tone with message on same line */}
        <div className="bg-white border-2 border-gray-200 rounded-xl p-4 mb-6 hover:border-blue-400 transition-all duration-200">
          <div className="flex flex-wrap gap-4 justify-between items-center">
            <div className="flex gap-6">
              <div>
                <Label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Dialect</Label>
                <Select value={forcedDialect || "auto"} onValueChange={(val) => setForcedDialect(val === "auto" ? undefined : val)}>
                  <SelectTrigger className="h-8 text-sm w-[90px] hover:bg-blue-50 transition-colors">
                    <SelectValue placeholder="Auto" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="US">US</SelectItem>
                    <SelectItem value="UK">UK</SelectItem>
                    <SelectItem value="AU">AU</SelectItem>
                    <SelectItem value="CA">CA</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Domain</Label>
                <Select value={domain} onValueChange={setDomain}>
                  <SelectTrigger className="h-8 text-sm w-[100px] hover:bg-blue-50 transition-colors">
                    <SelectValue placeholder="General" />
                  </SelectTrigger>
                  <SelectContent>
                    {DOMAINS.map((d) => (<SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Tone</Label>
                <Select value={tone} onValueChange={setTone}>
                  <SelectTrigger className="h-8 text-sm w-[100px] hover:bg-blue-50 transition-colors">
                    <SelectValue placeholder="Neutral" />
                  </SelectTrigger>
                  <SelectContent>
                    {TONES.map((t) => (<SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
<span className="text-base font-bold text-blue-600">Refine, compare, and approve sentence by sentence</span>              <span className="text-xs text-gray-400">· {wordCount} words · {remainingUses}/{DAILY_LIMIT} remaining</span>
            </div>
          </div>
        </div>

        {/* Two-column layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-stretch">
          
          {/* Left Column: Source Text */}
          <div className="space-y-4 h-full flex flex-col">
<div className="flex items-center justify-between">
  <div>
    <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Source Text</h3>
    <p className="text-xs text-gray-400 mt-1">Paste your text here or import a Word document</p>
  </div>
  <div className="flex gap-2">
    <input type="file" ref={fileInputRef} className="hidden" accept=".docx" onChange={handleFileUpload} />
    <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={isReading || isLoading} className="text-xs h-7">
      {isReading ? "Reading..." : "Import Word"}
    </Button>
    {inputText && (
      <Button variant="ghost" size="sm" onClick={() => setInputText("")} className="text-xs h-7 text-gray-400 hover:text-red-500">
        Clear
      </Button>
    )}
  </div>
</div>

            {/* Rich Text Editor with button inside */}
            <div className="border-2 border-gray-200 rounded-xl overflow-hidden bg-white hover:border-blue-400 transition-all duration-200 flex flex-col" style={{ height: "380px" }}>
              <div className="flex-1 overflow-auto">
                <RichTextEditor 
                  content={inputHtml}
                  onChange={handleEditorChange}
                  placeholder="Paste your text here..."
                  disabled={isLoading}
                />
              </div>
              <div className="border-t border-gray-100 p-3 bg-gray-50">
                <Button
<div className="flex gap-2">
  <Button
    className="flex-1 bg-gradient-to-r from-blue-500 via-blue-600 to-indigo-600 hover:from-blue-600 hover:via-blue-700 hover:to-indigo-700 text-white rounded-xl py-3 text-base font-bold shadow-2xl transition-all duration-300"
    onClick={handleTransform}
    disabled={isLoading || !inputText.trim()}
  >
    {isLoading ? (
      <><Sparkles className="w-4 h-4 animate-spin inline mr-2" /> Refining...</>
    ) : (
      <><Sparkles className="w-4 h-4 inline mr-2" /> Transform to Native English →</>
    )}
  </Button>
  {result && !isLoading && (
    <Button
      variant="outline"
      className="rounded-xl py-3 px-4 text-sm font-semibold border-2 border-blue-300 text-blue-600 hover:bg-blue-50 transition-all"
      onClick={handleTransform}
      title="Not happy with the result? Try again for a different output."
    >
      ↺ Retry
    </Button>
  )}
</div>
              </div>
            </div>

            {/* Notices below the editor box */}
            <div className="space-y-2">
              <p className="text-xs text-center text-gray-400">
                🔒 Private by default · No sign-up required
              </p>
              <p className="text-xs text-center text-gray-400">
                By pasting text or importing a document, you agree to IdiomOptima's <a href="/terms.html" className="text-blue-600 hover:underline">Terms of Service</a> and <a href="/privacy.html" className="text-blue-600 hover:underline">Privacy Policy</a>.
              </p>
            </div>
          </div>

          {/* Right Column: Results */}
          <div className="space-y-4 h-full flex flex-col bg-blue-50/20 border border-blue-100 rounded-xl p-4">
            <div className="flex items-center justify-between">
<h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Final Version</h3>              
<div className="flex gap-2">
  {result && (
    <button
      onClick={() => setShowDiff(!showDiff)}
      className={`text-xs px-2 py-1 rounded-full border transition-all ${
        showDiff 
          ? 'bg-blue-600 text-white border-blue-600' 
          : 'bg-white text-gray-500 border-gray-300 hover:border-blue-400'
      }`}
    >
      {showDiff ? '● Diff On' : '○ Show Diff'}
    </button>
  )}
  <Button variant="outline" size="sm" className="text-xs h-7" onClick={exportToPDF}>Export PDF</Button>
  <Button variant="outline" size="sm" className="text-xs h-7" onClick={copyToClipboard}>Copy</Button>
  <Button variant="outline" size="sm" className="text-xs h-7" onClick={exportToWord}>Export Word</Button>
</div>
            </div>

            <AnimatePresence mode="wait" className="flex-1">
              {isLoading ? (
                <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
                  <Card>
                    <CardHeader>
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-1/3" />
                        <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <motion.div initial={{ width: 0 }} animate={{ width: `${progress}%` }} className="h-full bg-blue-600" />
                        </div>
                        <p className="text-xs text-gray-400">{processingStatus}</p>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <Skeleton className="h-48 w-full" />
                    </CardContent>
                  </Card>
                </motion.div>
              ) : result ? (
                <motion.div key="result" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                  {/* Quality Metrics */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-white border border-gray-200 rounded-lg p-3">
                      <div className="text-xs text-gray-400">Source Quality</div>
                      <div className="text-2xl font-bold text-gray-900">{result.originalScore}%</div>
                      <div className="text-xs text-gray-400">Original text</div>
                    </div>
                    <div className="bg-blue-600 rounded-lg p-3 text-white">
                      <div className="text-xs text-white/70">Refined Quality</div>
                      <div className="text-2xl font-bold">{result.revisedScore}%</div>
                      <div className="text-xs text-white/70">After refinement</div>
                    </div>
                  </div>

                  {/* Refined Output */}
        <div className="bg-white border-2 border-gray-200 rounded-xl p-4 mb-6 hover:border-blue-400 transition-all duration-200">                    
<div className="text-gray-700 font-serif leading-relaxed text-lg">                      {result.sentences && result.sentences.length > 0 ? (
                        (() => {
                          const bodyGroups: any[] = [];
                          let currentGroup: any[] = [];

                          result.sentences.forEach((sent, idx) => {
                            const isSwapped = swappedSentenceIndices.includes(idx);
                            const text = isSwapped ? sent.original : sent.native;
                            
                            const defMatch = text.trim().match(FOOTNOTE_DEF_REGEX);
                            const isFootnoteDef = (!sent.isHeading && !!defMatch) || sent.isImmutableFootnote;
                            const isReferencesHeading = sent.isHeading && (
                              text.toLowerCase() === "references" || 
                              text.toLowerCase() === "bibliography" || 
                              text.toLowerCase() === "footnotes"
                            );
                            
                            if (isFootnoteDef || isReferencesHeading) return;

                            if (editingIndex === idx) {
                              bodyGroups.push(
                                <div key={`edit-${idx}`} className="my-2">
                                  <input
                                    type="text"
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    onBlur={() => saveEdit(idx)}
                                    onKeyDown={(e) => handleKeyDown(e, idx)}
                                    className="w-full p-1 border border-gray-300 rounded text-sm"
                                    autoFocus
                                  />
                                </div>
                              );
                              return;
                            }

const content = (
  <span
    key={idx}
    onClick={() => {
      setSwappedSentenceIndices(prev => 
        prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]
      );
    }}
    onDoubleClick={() => startEdit(idx, text)}
    title={`Original: ${sent.original}`}
    className={`cursor-pointer transition-all duration-200 relative group inline p-0.5 rounded hover:bg-gray-50
      ${sent.isNativeMatch ? 'border-b border-blue-200' : ''}
      ${isSwapped ? 'text-gray-400 bg-gray-50' : ''}
      ${sent.isHeading ? 'font-bold block text-lg mt-4 mb-2' : ''}
    `}
  >
<span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 opacity-0 group-hover:opacity-100 transition-opacity bg-gray-900 text-white p-4 rounded-xl text-sm leading-relaxed pointer-events-none z-[110] shadow-xl w-96 whitespace-normal">
  <span className="block text-gray-400 text-xs font-semibold uppercase tracking-wider mb-1">Original</span>
  {sent.original}
  <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
</span>
    {showDiff && !isSwapped && !sent.isNativeMatch 
      ? renderDiff(sent.original, sent.native)
      : renderContentWithFootnotes(text)
    }
    {isSwapped && <RotateCcw className="w-3 h-3 text-gray-400 inline ml-1 align-middle" />}
  </span>
);

                            if (sent.isHeading) {
                              if (currentGroup.length > 0) {
                                bodyGroups.push(<div key={`p-${idx}-pre`} className="mb-3 last:mb-0">{currentGroup}</div>);
                                currentGroup = [];
                              }
                              bodyGroups.push(content);
                            } else {
                              currentGroup.push(content);
                              if (sent.isEndOfParagraph) {
                                bodyGroups.push(<div key={`p-${idx}`} className="mb-3 last:mb-0">{currentGroup}</div>);
                                currentGroup = [];
                              }
                            }
                          });

                          if (currentGroup.length > 0) {
                            bodyGroups.push(<div key="p-last" className="mb-0">{currentGroup}</div>);
                          }

                          return (
                            <>
                              <div className="space-y-3">{bodyGroups}</div>
                              {Object.keys(footnoteMap).length > 0 && (
                                <div className="mt-6 pt-4 border-t border-dashed border-gray-200">
                                  <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Notes & References</h4>
                                  <div className="space-y-1">
                                    {Object.entries(footnoteMap).sort((a,b) => parseInt(a[0]) - parseInt(b[0])).map(([num, content]) => (
                                      <div key={num} ref={el => { footnoteRefs.current[num] = el; }} className="flex gap-2 text-xs text-gray-500">
                                        <span className="font-bold text-blue-500 min-w-[2rem]">[{num}]</span>
                                        <span>{content}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </>
                          );
                        })()
                      ) : (
                        <div className="whitespace-pre-wrap">{renderContentWithFootnotes(result.finalVersion)}</div>
                      )}
                    </div>
                  </div>

                  {/* Key Improvements */}
                  <div className="bg-gray-50 rounded-lg p-4">
                    <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">Key Improvements</h3>
                    <ul className="space-y-1">
                      {result.suggestions.map((s, i) => (
                        <li key={i} className="text-xs text-gray-600 flex gap-2">
                          <span className="text-blue-500">•</span> {s}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Stylistic Note */}
                  <div className="bg-gray-50 rounded-lg p-4">
                    <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-2">Stylistic Note</h3>
                    <p className="text-xs text-gray-500">{result.explanation}</p>
                  </div>
                </motion.div>
              ) : (
                <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full">
                  <div className="bg-transparent border-2 border-blue-200 rounded-lg overflow-hidden" style={{ height: "380px", display: "flex", flexDirection: "column" }}>                    <div className="flex-1 p-4 space-y-3">                      {/* ← Add your text box - light blue */}
                      <div className="bg-blue-50 border border-blue-100 rounded-lg p-6 text-left">
                        <span className="text-2xl text-gray-500 mr-2">←</span>
                        <span className="text-xl font-medium text-gray-700">Add your text</span>
                      </div>
                      {/* Information box - light blue (kept) */}
                      <div className="bg-blue-50 border border-blue-100 rounded-lg p-4">
                        <p className="text-sm text-gray-600">
                          Footnotes, citations, paragraph breaks, and document layout are preserved in the refined version.
                        </p>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>

      {/* History Sidebar */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowHistory(false)}
              className="fixed inset-0 bg-black/20 backdrop-blur-sm z-[60]"
            />
            <motion.div
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-white shadow-2xl z-[70] flex flex-col"
            >
              <div className="p-6 border-b border-[#E5E5E5] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HistoryIcon className="w-5 h-5" />
                  <h2 className="font-serif text-xl font-semibold">Recent History</h2>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setShowHistory(false)}>
                  <ChevronRight className="w-5 h-5" />
                </Button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {history.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-[#999]">
                    <HistoryIcon className="w-12 h-12 mb-4 opacity-20" />
                    <p>No history yet</p>
                  </div>
                ) : (
                  history.map((item) => (
                    <Card 
                      key={item.id} 
                      className="border-[#E5E5E5] hover:border-[#1A1A1A] transition-colors cursor-pointer group"
                      onClick={() => loadFromHistory(item)}
                    >
                      <CardHeader className="p-4 pb-2">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-bold uppercase tracking-widest text-[#999]">
                            {new Date(item.timestamp).toLocaleTimeString()}
                          </span>
                          <div className="flex gap-2">
                            <span className="text-[10px] bg-[#F5F5F5] px-1.5 py-0.5 rounded uppercase font-bold text-[#666]">
                              {item.domain}
                            </span>
                            <span className="text-[10px] bg-[#F5F5F5] px-1.5 py-0.5 rounded uppercase font-bold text-[#666]">
                              {item.tone}
                            </span>
                          </div>
                        </div>
                        <p className="text-sm font-medium line-clamp-2 text-[#1A1A1A]">
                          {item.originalText}
                        </p>
                      </CardHeader>
                      <CardContent className="p-4 pt-0">
                        <Separator className="my-2 opacity-50" />
                        <p className="text-xs italic text-[#666] line-clamp-2">
                          "{item.finalVersion}"
                        </p>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>

              {history.length > 0 && (
                <div className="p-6 border-t border-[#E5E5E5]">
                  <Button 
                    variant="outline" 
                    className="w-full text-destructive hover:text-destructive hover:bg-destructive/5"
                    onClick={clearHistory}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Clear History
                  </Button>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Footer */}
        <footer className="max-w-[1600px] mx-auto px-8 py-10 border-t border-[#E5E5E5] mt-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-sm text-[#888]">
          <div><h4 className="font-bold text-[#1A1A1A] uppercase text-xs tracking-wider mb-3">Product</h4><ul className="space-y-2">
  <li><a href="/about.html" className="hover:text-[#1A1A1A] transition">About</a></li>
  <li><a href="/faq.html" className="hover:text-[#1A1A1A] transition">FAQ</a></li>
  <li><span className="text-gray-400">Pricing – coming soon</span></li>
</ul></div>
          <div><h4 className="font-bold text-[#1A1A1A] uppercase text-xs tracking-wider mb-3">Legal</h4><ul className="space-y-2"><li><a href="/terms.html" className="hover:text-[#1A1A1A] transition">Terms of Service</a></li><li><a href="/privacy.html" className="hover:text-[#1A1A1A] transition">Privacy & Security</a></li></ul></div>
<div>
  <h4 className="font-bold text-[#1A1A1A] uppercase text-xs tracking-wider mb-3">Connect</h4>
  <ul className="space-y-2">
    <li>
      <a
        href="mailto:contact@idiomoptima.com"
        className="hover:text-[#1A1A1A] transition flex items-center gap-1"
      >
        <Mail className="w-3.5 h-3.5" /> contact@idiomoptima.com
      </a>
    </li>
    <li>
      <a
        href="https://x.com/araddaoui"
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-[#1A1A1A] transition"
      >
        X / Twitter
      </a>
    </li>
    <li>
      <a
        href="https://www.linkedin.com/in/araddaoui/"
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-[#1A1A1A] transition"
      >
        LinkedIn
      </a>
    </li>
  </ul>
</div>        </div>
        <div className="mt-8 text-center text-xs text-gray-400 border-t border-gray-100 pt-6">
          © 2026 IdiomOptima • Free forever during beta • No credit card required
        </div>
      </footer>
      {/* Floating chat button (simulates Tawk.to) */}
      <div className="fixed bottom-6 right-6 z-50">
        <div className="w-14 h-14 bg-[#1A1A1A] rounded-full flex items-center justify-center shadow-lg hover:scale-105 transition cursor-default">
          <svg xmlns="http://www.w3.org/2000/svg" className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        </div>
      </div>      
    </div>
  );
}