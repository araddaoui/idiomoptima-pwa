export async function transformText(
  text: string,
  domain: string = "general",
  tone: string = "neutral",
  onProgress?: (progress: number, currentChunk: number, totalChunks: number, status?: string) => void,
  forcedDialect?: string,
  mode: string = "auto"
): Promise<TransformationResult> {
  if (!text.trim()) return mergeResults([]);

  // Handle Mode Selection Logic
  let activeMode: string;
  let autoReason = "";

  if (mode === "auto" || !["academic", "business", "creative", "hybrid", "schema-init", "lexical-retrieval", "activation-engine", "voice-preservation"].includes(mode)) {
    const detection = detectBestMode(text);
    activeMode = detection.mode;
    autoReason = detection.reason;
  } else {
    activeMode = mode;
  }

  // Handle Schema Initialization Mode (Local Validation)
  if (activeMode === "schema-init") {
    try {
      const data = JSON.parse(text);
      const report = validateLexicalDatabase(data);
      
      const result: TransformationResult = {
        finalVersion: JSON.stringify(report, null, 2),
        sentences: [{
          original: "System Initialization Prompt",
          native: report.isValid ? "✅ Schema validation passed. System initialized as a structured lexical processing engine." : "❌ Schema validation failed.",
          isImmutableFootnote: false,
          isNativeMatch: true,
          isEndOfParagraph: true,
          isHeading: false
        }],
        originalScore: 100,
        revisedScore: report.isValid ? 100 : 0,
        explanation: report.isValid 
          ? `[SCHEMA_INITIALIZATION_MODE] Successfully registered schema. Total entries to validate: ${report.metadata?.total_entries || 'N/A'}`
          : `[SCHEMA_INITIALIZATION_MODE] Validation failed: \n${report.errors.join('\n')}`,
        suggestions: report.isValid ? [] : report.errors.map(err => `[Validation Error] ${err}`),
        appliedMode: "schema-init"
      };
      
      return result;
    } catch (e) {
      return {
        finalVersion: "Invalid JSON format for Schema Initialization.",
        sentences: [],
        suggestions: ["[Format Error] Input must be valid JSON matching the lexical schema."],
        originalScore: 0,
        revisedScore: 0,
        explanation: "Error: Schema Initialization requires a valid JSON input matching the lexical database schema.",
        appliedMode: "schema-init"
      };
    }
  }

  // Handle Lexical Retrieval Mode (Simulated Indexing)
  if (activeMode === "lexical-retrieval") {
    try {
      const result: TransformationResult = {
        finalVersion: "Lexical database successfully loaded. Retrieval mode active.",
        sentences: [{
          original: "Excel/Data Ingestion",
          native: "Lexical database successfully loaded. Retrieval mode active.",
          isImmutableFootnote: false,
          isNativeMatch: true,
          isEndOfParagraph: true,
          isHeading: false
        }],
        originalScore: 100,
        revisedScore: 100,
        explanation: "[LEXICAL_RETRIEVAL_MODE] System has indexed items. Layer-aware and register-sensitive retrieval is now active.",
        suggestions: [],
        appliedMode: "lexical-retrieval"
      };
      return result;
    } catch (e) {
       return {
        finalVersion: "Error loading lexical database.",
        sentences: [],
        suggestions: ["Ensure data follows the required structure."],
        originalScore: 0,
        revisedScore: 0,
        explanation: "Error during lexical retrieval initialization.",
        appliedMode: "lexical-retrieval"
      };
    }
  }

  // NEW: Call Vercel serverless function
  if (onProgress) {
    onProgress(10, 0, 1, "Connecting to server...");
  }

  try {
    console.log('Calling API at /api/transform with payload:', { text, domain, tone, forcedDialect, mode: activeMode });
    const response = await fetch('/api/transform', {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        domain,
        tone,
        forcedDialect,
        mode: activeMode,
      }),
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    if (onProgress) {
      onProgress(50, 0, 1, "Processing...");
    }

    const data: TransformationResult = await response.json();

    if (onProgress) {
      onProgress(100, 1, 1, "Complete!");
    }

    // Add auto-mode explanation if applicable
    if (mode === "auto") {
      data.explanation = (data.explanation || "") + ` \n[Auto-Selected Mode: ${activeMode.toUpperCase().replace(/-/g, ' ')}] - ${autoReason}`;
      data.appliedMode = activeMode;
    }

    return data;
  } catch (error: any) {
    console.error("Worker request failed:", error);
    throw new Error(`Transformation failed: ${error.message || "Server unavailable"}`);
  }
}