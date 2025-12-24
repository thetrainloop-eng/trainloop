export interface DiffChunk {
  type: 'added' | 'removed' | 'modified';
  before: string | null;
  after: string | null;
  location: string | null;
  lineNumber?: number;
}

export interface DiffResult {
  chunks: DiffChunk[];
  summary: {
    added: number;
    removed: number;
    modified: number;
  };
  highRiskPhrases: string[];
  hasHighRiskChanges: boolean;
  isProcedural: boolean;
  requirements: RequirementStatement[];
}

const HIGH_RISK_PHRASES = [
  'sell', 'share', 'disclose', 'third party', 'transfer', 'retain', 'collect',
  'consent', 'opt out', 'opt-out', 'marketing', 'undisclosed', 'PII', 'personal data',
  'personal information', 'data breach', 'security incident', 'confidential',
  'terminate', 'penalty', 'fine', 'lawsuit', 'liability', 'waive', 'forfeit'
];

const OBLIGATION_VERBS = [
  'must', 'shall', 'required', 'need to', 'needs to', 'have to', 'has to',
  'will be required', 'is required', 'are required', 'mandatory', 'obligated',
  'responsible for', 'expected to', 'ensure', 'ensure that'
];

const SYSTEM_KEYWORDS = [
  'system', 'software', 'platform', 'tool', 'application', 'database',
  'electronic', 'digital', 'online', 'portal', 'Google Drive', 'SharePoint',
  'CRM', 'ERP', 'LMS', 'intranet'
];

const TRAINING_KEYWORDS = [
  'training', 'trained', 'certification', 'certified', 'course', 'learning',
  'onboarding', 'orientation', 'workshop', 'seminar'
];

const STORAGE_KEYWORDS = [
  'store', 'stored', 'storage', 'archive', 'retain', 'retention', 'file',
  'folder', 'directory', 'document', 'record', 'backup'
];

export interface RequirementStatement {
  text: string;
  beforeText: string | null;
  afterText: string | null;
  category: 'step' | 'obligation' | 'system' | 'training' | 'storage' | 'responsibility';
  appliesTo: string | null;
  location: string | null;
  isNew: boolean;
}

function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

function findNearestHeading(text: string, position: number): string | null {
  const beforeText = text.substring(0, position);
  const lines = beforeText.split('\n');
  
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length > 0 && line.length < 100) {
      if (/^[A-Z0-9]/.test(line) && 
          (line.endsWith(':') || /^[A-Z][A-Z\s]+$/.test(line) || /^\d+\./.test(line) || /^#{1,3}\s/.test(line))) {
        return line.replace(/^#+\s*/, '').replace(/:$/, '');
      }
    }
  }
  return null;
}

function detectHighRiskPhrases(text: string): string[] {
  const found: string[] = [];
  const lowerText = text.toLowerCase();
  
  for (const phrase of HIGH_RISK_PHRASES) {
    if (lowerText.includes(phrase.toLowerCase())) {
      found.push(phrase);
    }
  }
  return [...new Set(found)];
}

function truncateExcerpt(text: string, maxWords: number = 30): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '...';
}

export function detectProceduralDocument(fileName: string, content: string): boolean {
  const lowerName = fileName.toLowerCase();
  const lowerContent = content.toLowerCase();
  
  if (lowerName.includes('sop') || lowerName.includes('procedure')) {
    return true;
  }
  
  const contentKeywords = ['sop', 'standard operating procedure', 'procedure'];
  for (const kw of contentKeywords) {
    if (lowerContent.includes(kw)) return true;
  }
  
  const numberedStepPattern = /(?:step\s*\d|^\s*\d+\.\s+[A-Z])/im;
  if (numberedStepPattern.test(content)) return true;
  
  return false;
}

function extractAppliesTo(text: string): string | null {
  const rolePatterns = [
    /all\s+(\w+(?:\s+\w+)?(?:\s+representatives?|\s+staff|\s+employees?|\s+personnel|\s+team)?)/i,
    /(\w+(?:-facing)?\s+(?:representatives?|staff|employees?|personnel|team))/i,
    /(?:responsible\s+for|assigned\s+to)\s+(\w+(?:\s+\w+)?)/i,
    /(managers?|supervisors?|administrators?|leads?|directors?)/i,
  ];
  
  for (const pattern of rolePatterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

function categorizeRequirement(text: string): RequirementStatement['category'] {
  const lowerText = text.toLowerCase();
  
  if (/^\s*(?:step\s*\d|\d+\.\s)/i.test(text)) return 'step';
  
  for (const kw of TRAINING_KEYWORDS) {
    if (lowerText.includes(kw)) return 'training';
  }
  
  for (const kw of STORAGE_KEYWORDS) {
    if (lowerText.includes(kw)) return 'storage';
  }
  
  for (const kw of SYSTEM_KEYWORDS) {
    if (lowerText.includes(kw)) return 'system';
  }
  
  if (/responsible|assigned|duty|duties|role/i.test(lowerText)) return 'responsibility';
  
  return 'obligation';
}

function containsObligationVerb(text: string): boolean {
  const lowerText = text.toLowerCase();
  return OBLIGATION_VERBS.some(verb => lowerText.includes(verb));
}

function containsSystemKeyword(text: string): boolean {
  const lowerText = text.toLowerCase();
  return SYSTEM_KEYWORDS.some(kw => lowerText.includes(kw));
}

function extractRequirementSentences(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  return sentences.filter(s => 
    containsObligationVerb(s) || 
    containsSystemKeyword(s) ||
    TRAINING_KEYWORDS.some(kw => s.toLowerCase().includes(kw)) ||
    STORAGE_KEYWORDS.some(kw => s.toLowerCase().includes(kw))
  );
}

export function extractRequirementsFromChunks(
  chunks: DiffChunk[],
  previousContent: string,
  newContent: string
): RequirementStatement[] {
  const requirements: RequirementStatement[] = [];
  
  for (const chunk of chunks) {
    if (chunk.type === 'added' && chunk.after) {
      const sentences = extractRequirementSentences(chunk.after);
      for (const sentence of sentences) {
        requirements.push({
          text: sentence,
          beforeText: null,
          afterText: chunk.after,
          category: categorizeRequirement(sentence),
          appliesTo: extractAppliesTo(sentence),
          location: chunk.location,
          isNew: true,
        });
      }
    } else if (chunk.type === 'modified' && chunk.after) {
      const afterSentences = extractRequirementSentences(chunk.after);
      const beforeSentences = chunk.before ? extractRequirementSentences(chunk.before) : [];
      
      for (const sentence of afterSentences) {
        const wasInBefore = beforeSentences.some(bs => 
          bs.toLowerCase().trim() === sentence.toLowerCase().trim()
        );
        
        if (!wasInBefore) {
          requirements.push({
            text: sentence,
            beforeText: chunk.before,
            afterText: chunk.after,
            category: categorizeRequirement(sentence),
            appliesTo: extractAppliesTo(sentence),
            location: chunk.location,
            isNew: true,
          });
        }
      }
    }
  }
  
  return requirements;
}

function computeLCSMatrix(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

function backtrackDiff(dp: number[][], a: string[], b: string[]): Array<{ type: 'same' | 'removed' | 'added'; value: string; indexA?: number; indexB?: number }> {
  const result: Array<{ type: 'same' | 'removed' | 'added'; value: string; indexA?: number; indexB?: number }> = [];
  let i = a.length;
  let j = b.length;
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.unshift({ type: 'same', value: a[i - 1], indexA: i - 1, indexB: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'added', value: b[j - 1], indexB: j - 1 });
      j--;
    } else {
      result.unshift({ type: 'removed', value: a[i - 1], indexA: i - 1 });
      i--;
    }
  }
  return result;
}

export function computeTextDiff(previousContent: string, newContent: string, maxChunks: number = 8): DiffResult {
  const prevParagraphs = splitIntoParagraphs(previousContent);
  const newParagraphs = splitIntoParagraphs(newContent);
  
  const dp = computeLCSMatrix(prevParagraphs, newParagraphs);
  const diffOps = backtrackDiff(dp, prevParagraphs, newParagraphs);
  
  const chunks: DiffChunk[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let modifiedCount = 0;
  const allHighRiskPhrases: string[] = [];
  
  let i = 0;
  while (i < diffOps.length) {
    const op = diffOps[i];
    
    if (op.type === 'same') {
      i++;
      continue;
    }
    
    if (op.type === 'removed' && i + 1 < diffOps.length && diffOps[i + 1].type === 'added') {
      const before = op.value;
      const after = diffOps[i + 1].value;
      const location = findNearestHeading(previousContent, previousContent.indexOf(before));
      
      const addedText = after.replace(before, '');
      const hrPhrases = detectHighRiskPhrases(addedText);
      allHighRiskPhrases.push(...hrPhrases);
      
      chunks.push({
        type: 'modified',
        before: truncateExcerpt(before),
        after: truncateExcerpt(after),
        location,
      });
      modifiedCount++;
      i += 2;
    } else if (op.type === 'added') {
      const location = findNearestHeading(newContent, newContent.indexOf(op.value));
      const hrPhrases = detectHighRiskPhrases(op.value);
      allHighRiskPhrases.push(...hrPhrases);
      
      chunks.push({
        type: 'added',
        before: null,
        after: truncateExcerpt(op.value),
        location,
      });
      addedCount++;
      i++;
    } else if (op.type === 'removed') {
      const location = findNearestHeading(previousContent, previousContent.indexOf(op.value));
      
      chunks.push({
        type: 'removed',
        before: truncateExcerpt(op.value),
        after: null,
        location,
      });
      removedCount++;
      i++;
    } else {
      i++;
    }
  }
  
  const uniqueHighRisk = [...new Set(allHighRiskPhrases)];
  
  const prioritizedChunks = chunks.sort((a, b) => {
    const aHasRisk = a.after ? detectHighRiskPhrases(a.after).length > 0 : false;
    const bHasRisk = b.after ? detectHighRiskPhrases(b.after).length > 0 : false;
    if (aHasRisk && !bHasRisk) return -1;
    if (!aHasRisk && bHasRisk) return 1;
    return 0;
  }).slice(0, maxChunks);
  
  const requirements = extractRequirementsFromChunks(prioritizedChunks, previousContent, newContent);
  
  return {
    chunks: prioritizedChunks,
    summary: {
      added: addedCount,
      removed: removedCount,
      modified: modifiedCount,
    },
    highRiskPhrases: uniqueHighRisk,
    hasHighRiskChanges: uniqueHighRisk.length > 0,
    isProcedural: false,
    requirements,
  };
}

export function computeTextDiffWithContext(
  previousContent: string,
  newContent: string,
  fileName: string,
  maxChunks: number = 8
): DiffResult {
  const result = computeTextDiff(previousContent, newContent, maxChunks);
  result.isProcedural = detectProceduralDocument(fileName, newContent);
  return result;
}
