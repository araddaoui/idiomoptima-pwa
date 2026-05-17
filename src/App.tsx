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
      const example = "He explained me the problem very clear, but I didn't understood his point. We need to discuss about this further.";
      setInputText(example);
      setInputHtml(example);
      setDemoShown(true);
      // Optional: auto-transform
      setTimeout(() => handleTransform(), 100);
    }
  }, [demoShown, inputText]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const fileType = file.name.split('.').pop()?.toLowerCase();
    
    if (fileType !== 'docx' && fileType !== 'pdf') {
      toast.error("IdiomOptima currently supports .docx and .pdf files only.");
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
      const data = await transformText(inputText, domain, tone, (p, current, total, extraStatus) => {
        setProgress(p);
        let status = total > 1 ? `Processing section ${current + 1} of ${total}...` : "Nativizing text...";
        if (extraStatus) status = extraStatus;
        setProcessingStatus(status);
      }, forcedDialect, mode);

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
    
    const textToCopy = getVisibleText();

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
        <div className="max-w-[1600px] mx-auto px-4 sm:px-8 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          {/* Logo + title – centered on mobile, left on desktop */}
          <div className="flex items-center justify-center sm:justify-start gap-3">
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
          {/* Buttons – wrap on mobile, stay on right on desktop */}
          <div className="flex items-center justify-center sm:justify-end gap-2 flex-wrap">
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
      </header>

      <main className="max-w-[1600px] mx-auto px-8 py-8">
        {/* Hero Section – enhanced */}
        <div className="mb-12 text-center w-full">
          <div className="max-w-3xl mx-auto">
<h1 className="font-serif text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight leading-tight mb-3 bg-gradient-to-r from-[#0F172A] via-[#1E3A8A] to-[#1E293B] bg-clip-text text-transparent text-center mx-auto px-2">
  Elevate your writing<br />without losing your voice
</h1>
<div className="flex flex-wrap items-center justify-center gap-2 my-4">
  <span className="text-xs text-gray-400 uppercase tracking-wider">Try an example:</span>
  
  <button
    title="Essay, thesis, journal article – refine for clarity and formal tone"
    onClick={() => {
      const example = "The results of the experiment demonstrates that there is a significant correlation between the variables, however further research is needed to establish causality.[1]";
      setInputText(example);
      setInputHtml(example);
      toast.info("🎓 Academic example loaded – try transforming it!");
    }}
    className="px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 transition flex items-center gap-1"
  >
    <span>🎓</span> Academic
  </button>

  <button
    title="Report, proposal, business email – make concise and professional"
    onClick={() => {
      const example = "Please find attached the quarterly report. We need to discuss about the budget allocation for next quarter as soon as possible.";
      setInputText(example);
      setInputHtml(example);
      toast.info("💼 Business example loaded – try transforming it!");
    }}
    className="px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 transition flex items-center gap-1"
  >
    <span>💼</span> Business
  </button>

  <button
    title="Story, blog post, poem – enhance style without losing your voice"
    onClick={() => {
      const example = "The old house stood on the hill, its windows like empty eyes staring at the town bellow. No one had visited in years.";
      setInputText(example);
      setInputHtml(example);
      toast.info("✍️ Creative example loaded – try transforming it!");
    }}
    className="px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 transition flex items-center gap-1"
  >
    <span>✍️</span> Creative
  </button>

  <button
    title="Resume, cover letter, LinkedIn summary – polish for impact"
    onClick={() => {
      const example = "I am writing to apply for the marketing position. I have 5 years of experience and I think I would be a good fit for your company.";
      setInputText(example);
      setInputHtml(example);
      toast.info("📧 Professional example loaded – try transforming it!");
    }}
    className="px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 transition flex items-center gap-1"
  >
    <span>📧</span> Professional
  </button>

  <button
    title="English learners – get native‑level fluency suggestions"
    onClick={() => {
      const example = "I have been learning English for two years. Yesterday I go to the store and buy some apples, but I forget my wallet at home.";
      setInputText(example);
      setInputHtml(example);
      toast.info("🌍 ESL example loaded – try transforming it!");
    }}
    className="px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 transition flex items-center gap-1"
  >
    <span>🌍</span> ESL
  </button>
</div>
            <p className="text-gray-500 text-sm mb-5 text-center">
              ✨ Get native‑level English in one click – no sign‑up required.
            </p>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Button onClick={scrollToInput} className="bg-[#1A1A1A] hover:bg-[#333] text-white px-6 py-2.5 rounded-full text-sm font-medium shadow-md">
                <PenLine className="w-4 h-4 mr-2" /> Refine Your Text
              </Button>
              <span className="text-xs text-[#999] bg-[#F5F5F5] px-3 py-1.5 rounded-full">Pricing – coming soon</span>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 mt-6 text-xs text-[#888]">
              <div className="flex items-center gap-1"><Shield className="w-3.5 h-3.5" /><span>Your text is processed securely and not stored</span></div>
              <span>•</span>
              <div><span className="mr-1">⭐</span>Trusted by 100+ early users</div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10" ref={inputSectionRef}>
          
          {/* Left Column: Input & Controls */}
          <div className="space-y-4">
            
            {/* Global Refinement Controls - Compact Horizontal Row */}
            <section className="max-w-2xl mx-auto md:mx-0 p-3 bg-white border border-[#E5E5E5] rounded-2xl shadow-sm">
              <div className="grid grid-cols-3 gap-6">
                <div className="space-y-1">
                  <Label className="text-[10px] font-bold text-[#666] uppercase tracking-[0.15em] pl-0.5">Dialect</Label>
                  <Select value={forcedDialect || "auto"} onValueChange={(val) => setForcedDialect(val === "auto" ? undefined : val)}>
                    <SelectTrigger className={`h-8 text-xs border-[#E5E5E5] focus:ring-[#1A1A1A] transition-all duration-300 ${result && result.detectedDialect === forcedDialect ? 'border-green-500 bg-green-50/20' : ''}`}>
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
                
                <div className="space-y-1">
                  <Label className="text-[10px] font-bold text-[#666] uppercase tracking-[0.15em] pl-0.5">Domain</Label>
                  <Select value={domain} onValueChange={setDomain}>
                    <SelectTrigger className="h-8 text-xs border-[#E5E5E5] focus:ring-[#1A1A1A]">
                      <SelectValue placeholder="General" />
                    </SelectTrigger>
                    <SelectContent>
                      {DOMAINS.map((d) => (
                        <SelectItem key={d.value} value={d.value} className="text-xs">
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1">
                  <Label className="text-[10px] font-bold text-[#666] uppercase tracking-[0.15em] pl-0.5">Tone</Label>
                  <Select value={tone} onValueChange={setTone}>
                    <SelectTrigger className="h-8 text-xs border-[#E5E5E5] focus:ring-[#1A1A1A]">
                      <SelectValue placeholder="Neutral" />
                    </SelectTrigger>
                    <SelectContent>
                      {TONES.map((t) => (
                        <SelectItem key={t.value} value={t.value} className="text-xs">
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>

            <section className="space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
                <div className="flex items-center justify-center sm:justify-start gap-2">
                  <Label htmlFor="input-text" className="text-[10px] font-black text-[#999] uppercase tracking-[0.2em] flex items-center gap-1">
                    <FileText className="w-3 h-3" /> Source Text
                  </Label>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <input type="file" ref={fileInputRef} className="hidden" accept=".docx,.pdf" onChange={handleFileUpload} />
                  <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={!consentGiven || isReading || isLoading} className="text-xs border-dashed">
                    {isReading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Plus className="w-3 h-3 mr-1" />}
                    {isReading ? "Reading..." : "Import Document"}
                  </Button>
                  {inputText && (
                    <Button variant="ghost" size="sm" onClick={() => setInputText("")} className="text-[#999] hover:text-red-500 hover:bg-red-50 h-8 text-[11px]">
                      <Trash2 className="w-3 h-3 mr-1" /> Clear
                    </Button>
                  )}
                  <span className="text-[10px] font-medium text-[#BBB] uppercase tracking-widest tabular-nums">
                    {wordCount} words
                  </span>
                  {remainingUses !== null && (
                    <span className="text-[10px] font-medium text-[#666]">· {remainingUses} / {DAILY_LIMIT} remaining today</span>
                  )}
                </div>
              </div>

              <div className="relative group border-2 border-[#E5E5E5] rounded-3xl overflow-hidden bg-white shadow-sm focus-within:ring-4 focus-within:ring-[#1A1A1A]/5 transition-all p-2 max-h-[280px] overflow-y-auto">
                <RichTextEditor 
                  content={inputHtml}
                  onChange={handleEditorChange}
                  placeholder={consentGiven ? "Paste your academic text here..." : "Please accept the Terms & Privacy first (click footer links)."}
                  disabled={!consentGiven || isLoading}
                />
                
                {isReading && (
                  <div className="absolute inset-0 bg-white/80 backdrop-blur-[4px] flex items-center justify-center rounded-lg z-20">
                    <div className="flex flex-col items-center gap-3">
                      <Loader2 className="w-8 h-8 animate-spin text-[#1A1A1A]" />
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#1A1A1A]">Reading Document...</p>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <Button
              className="w-full h-14 text-lg bg-gradient-to-r from-[#1E3A8A] to-[#2563EB] hover:from-[#333] hover:to-[#1A1A1A] text-white rounded-xl shadow-md transition-all flex items-center justify-center gap-2"
              onClick={handleTransform}
              disabled={!consentGiven || isLoading || !inputText.trim()}
            >
              {isLoading ? (
                <><Sparkles className="w-5 h-5 animate-spin" /> Refining your writing...</>
              ) : (
                <><PenLine className="w-5 h-5" /> Transform to Native English <ChevronRight className="w-4 h-4" /></>
              )}
            </Button>
          </div>

          {/* Right Column: Results */}
          <div className="">
            <AnimatePresence mode="wait">
              {isLoading ? (
                <motion.div
                  key="loading"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  className="space-y-6"
                >
                  <Card className="border-[#E5E5E5] shadow-none bg-white">
                    <CardHeader>
                      <div className="space-y-4">
                        <div className="flex items-center justify-between">
                          <Skeleton className="h-6 w-1/3" />
                          <div className="flex flex-col items-end gap-1">
                            <span className="text-[10px] font-bold uppercase tracking-widest text-[#999]">
                              {progress}%
                            </span>
                          </div>
                        </div>
                        <div className="w-full h-1.5 bg-[#F5F5F5] rounded-full overflow-hidden">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${progress}%` }}
                            className="h-full bg-[#1A1A1A]"
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-[#999] italic">
                            {processingStatus}
                          </p>
                          {forcedDialect && (
                            <span className="text-[10px] font-bold text-[#999] uppercase tracking-tighter">
                              Locked to: {forcedDialect}
                            </span>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <Skeleton className="h-[200px] w-full" />
                      <Separator />
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-1/4" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-full" />
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ) : result ? (
                <motion.div
                  key="result"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="space-y-6"
                >
                  <Card className="border-[#1A1A1A] border-2 shadow-xl bg-white overflow-hidden">
                    <CardHeader className="bg-[#1A1A1A] text-white py-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <CardTitle className="text-sm font-medium uppercase tracking-[0.2em]">Final Version</CardTitle>
                          {result.detectedDialect && (
                            <div className="flex items-center gap-2 px-2 py-0.5 bg-white/10 rounded-full text-[10px] uppercase font-bold tracking-widest leading-none">
                              <Languages className="w-3 h-3" />
                              {result.detectedDialect} English
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="text-white hover:bg-white/10"
                            onClick={exportToWord}
                            title="Export to Word"
                          >
                            <FileText className="w-4 h-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="text-white hover:bg-white/10"
                            onClick={exportToPDF}
                            title="Export to PDF"
                          >
                            <Download className="w-4 h-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="text-white hover:bg-white/10"
                            onClick={copyToClipboard}
                            title="Copy to Clipboard"
                          >
                            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="p-10">
                      <div className="text-xl font-serif leading-relaxed text-[#1A1A1A]">
                        {result.sentences && result.sentences.length > 0 ? (
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
                                      className="w-full p-2 border border-gray-300 rounded"
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
                                  className={`cursor-pointer transition-all duration-200 relative group inline p-0.5 rounded hover:bg-[#F5F5F5]
                                    ${sent.isNativeMatch ? 'border-b border-blue-200' : ''}
                                    ${isSwapped ? 'text-[#999] bg-[#F9F9F9]' : ''}
                                    ${sent.isHeading ? 'font-bold block text-3xl mt-10 mb-6' : ''}
                                  `}
                                >
                                  {/* Ghost Underlay - Tooltip style */}
                                  <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 opacity-0 group-hover:opacity-100 transition-opacity bg-[#1A1A1A] text-white p-3 rounded-xl text-sm italic whitespace-normal pointer-events-none z-[110] shadow-2xl w-72 transform -translate-y-1 leading-snug font-normal">
                                    {sent.original}
                                    {/* Tooltip Arrow */}
                                    <span className="absolute top-full left-1/2 -translate-x-1/2 border-8 border-transparent border-t-[#1A1A1A]" />
                                  </span>
                                  
                                  {renderContentWithFootnotes(text)}
                                  
                                  {isSwapped && (
                                    <RotateCcw className="w-3 h-3 text-[#999] inline ml-1 align-middle" />
                                  )}
                                  {!sent.isHeading && " "}
                                </span>
                              );

                              if (sent.isHeading) {
                                if (currentGroup.length > 0) {
                                  bodyGroups.push(
                                    <div key={`p-${idx}-pre`} className="mb-6 last:mb-0">
                                      {currentGroup}
                                    </div>
                                  );
                                  currentGroup = [];
                                }
                                bodyGroups.push(content);
                              } else {
                                currentGroup.push(content);
                                if (sent.isEndOfParagraph) {
                                  bodyGroups.push(
                                    <div key={`p-${idx}`} className="mb-6 last:mb-0">
                                      {currentGroup}
                                    </div>
                                  );
                                  currentGroup = [];
                                }
                              }
                            });

                            if (currentGroup.length > 0) {
                              bodyGroups.push(
                                <div key="p-last" className="mb-0">
                                  {currentGroup}
                                </div>
                              );
                            }

                            return (
                              <>
                                <div className="space-y-6">
                                  {bodyGroups}
                                </div>
                                
                                {/* References Section in Results Panel */}
                                {Object.keys(footnoteMap).length > 0 && (
                                  <div className="mt-16 pt-10 border-t-2 border-dashed border-gray-200">
                                    <h4 className="text-xs font-black uppercase tracking-[0.4em] text-gray-400 mb-8 flex items-center gap-3">
                                      <div className="h-[1px] w-8 bg-gray-300" />
                                      Notes & References
                                    </h4>
                                    <div className="space-y-4">
                                      {Object.entries(footnoteMap)
                                        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
                                        .map(([num, content]) => (
                                          <div 
                                            key={num} 
                                            ref={el => { footnoteRefs.current[num] = el; }}
                                            className="flex gap-4 text-sm font-serif italic text-gray-500 hover:text-gray-900 transition-colors"
                                          >
                                            <span className="font-bold text-blue-500/50 min-w-[2rem] text-right">[{num}]</span>
                                            <div className="leading-relaxed">{content}</div>
                                          </div>
                                        ))}
                                    </div>
                                  </div>
                                )}
                              </>
                            );
                          })()
                        ) : (
                          <div className="whitespace-pre-wrap leading-relaxed">
                            {renderContentWithFootnotes(result.finalVersion)}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>

                  {/* Authenticity Metrics Section */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 bg-white border border-[#E5E5E5] rounded-xl space-y-2">
                       <span className="text-[10px] font-bold uppercase tracking-widest text-[#999]">Original Authenticity</span>
                       <div className="flex items-end gap-2">
                         <span className="text-2xl font-serif font-bold">{result.originalScore}%</span>
                         <span className="text-[10px] text-[#999] mb-1">Human-like</span>
                       </div>
                       <div className="w-full h-1.5 bg-[#F5F5F5] rounded-full overflow-hidden">
                         <motion.div 
                           initial={{ width: 0 }}
                           animate={{ width: `${result.originalScore}%` }}
                           className="h-full bg-[#999]"
                         />
                       </div>
                    </div>
                    <div className="p-4 bg-[#1A1A1A] border border-[#1A1A1A] rounded-xl space-y-2 text-white">
                       <span className="text-[10px] font-bold uppercase tracking-widest text-white/50">Improved Authenticity</span>
                       <div className="flex items-end gap-2">
                         <span className="text-2xl font-serif font-bold">{result.revisedScore}%</span>
                         <span className="text-[10px] text-white/50 mb-1">Human-like</span>
                       </div>
                       <div className="w-full h-1.5 bg-white/10 rounded-full overflow-hidden">
                         <motion.div 
                           initial={{ width: 0 }}
                           animate={{ width: `${result.revisedScore}%` }}
                           className="h-full bg-white"
                         />
                       </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-[#666]">
                      <Sparkles className="w-4 h-4" />
                      <h3 className="text-xs font-bold uppercase tracking-widest">Key Improvements</h3>
                    </div>
                    <ul className="space-y-3">
                      {result.suggestions.map((s, i) => (
                        <motion.li 
                          key={i}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: i * 0.1 }}
                          className="flex items-start gap-3 text-sm text-[#444]"
                        >
                          <div className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#1A1A1A] shrink-0" />
                          {s}
                        </motion.li>
                      ))}
                    </ul>
                  </div>

                  <Separator className="bg-[#E5E5E5]" />

                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-[#666]">
                      <Info className="w-4 h-4" />
                      <h3 className="text-xs font-bold uppercase tracking-widest">Stylistic Note</h3>
                    </div>
                    <p className="text-sm text-[#666] leading-relaxed">
                      {result.explanation}
                    </p>
                  </div>
                </motion.div>
              ) : (
<motion.div
  key="empty"
  initial={{ opacity: 0 }}
  animate={{ opacity: 1 }}
  className="flex flex-col items-center text-center py-10 px-6 border-2 border-dashed border-[#E5E5E5] rounded-3xl"
>
  <div className="w-20 h-20 bg-[#F5F5F5] rounded-full flex items-center justify-center mb-4">
    <PenLine className="w-10 h-10 text-[#666]" />
  </div>
  <h3 className="font-serif text-3xl font-semibold mb-3">Ready to refine</h3>
  <p className="text-base text-[#666] max-w-[280px] mb-5">
    Try the example in the box, or paste your own text.
  </p>
  <button
    onClick={() => {
      const example = "He explained me the problem very clear, but I didn't understood his point.[1] We need to discuss about this further.";
      setInputText(example);
      setInputHtml(example);
      handleTransform();
    }}
    className="mt-2 text-base bg-[#1A1A1A] text-white px-8 py-3 rounded-full hover:bg-[#333] transition shadow-md font-medium"
  >
    <Lightbulb className="w-4 h-4 inline mr-2" /> Try an example
  </button>
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
          <div><h4 className="font-bold text-[#1A1A1A] uppercase text-xs tracking-wider mb-3">Connect</h4><ul className="space-y-2"><li><a href="mailto:contact@IdiomOptima.ai" className="hover:text-[#1A1A1A] transition flex items-center gap-1"><Mail className="w-3.5 h-3.5" /> contact@IdiomOptima.ai</a></li><li><a href="#" className="hover:text-[#1A1A1A] transition"><i className="fab fa-twitter mr-1"></i> Twitter</a></li><li><a href="#" className="hover:text-[#1A1A1A] transition"><i className="fab fa-linkedin mr-1"></i> LinkedIn</a></li></ul></div>
        </div>
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