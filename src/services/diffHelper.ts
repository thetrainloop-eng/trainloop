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
}

const HIGH_RISK_PHRASES = [
  'sell', 'share', 'disclose', 'third party', 'transfer', 'retain', 'collect',
  'consent', 'opt out', 'opt-out', 'marketing', 'undisclosed', 'PII', 'personal data',
  'personal information', 'data breach', 'security incident', 'confidential',
  'terminate', 'penalty', 'fine', 'lawsuit', 'liability', 'waive', 'forfeit'
];

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
  
  return {
    chunks: prioritizedChunks,
    summary: {
      added: addedCount,
      removed: removedCount,
      modified: modifiedCount,
    },
    highRiskPhrases: uniqueHighRisk,
    hasHighRiskChanges: uniqueHighRisk.length > 0,
  };
}
