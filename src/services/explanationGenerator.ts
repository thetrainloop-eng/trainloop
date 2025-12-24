import { 
  ChangeRecord, 
  ChangeReason, 
  ExplanationInput, 
  ExplanationOutput, 
  ExplanationBullets, 
  ExplanationMeta,
  ChangeItem,
  SOPRequirement
} from '../types';
import { db } from '../db';
import { 
  computeTextDiff, 
  computeTextDiffWithContext,
  DiffResult,
  RequirementStatement,
  detectProceduralDocument
} from './diffHelper';

export interface IExplanationGenerator {
  generateExplanation(input: ExplanationInput): Promise<ExplanationOutput>;
  isEnabled(): boolean;
}

function parseReason(record: ChangeRecord): ChangeReason {
  if (!record.reason) return {};
  try {
    return JSON.parse(record.reason);
  } catch {
    return {};
  }
}

function createDeterministicExplanation(
  text: string,
  bullets: ExplanationBullets,
  meta: Partial<ExplanationMeta> = {}
): ExplanationOutput {
  return {
    text,
    bullets,
    meta: {
      deterministic: true,
      confidence: meta.confidence || 'high',
      promptVersion: 'deterministic-v2',
      ...meta,
    },
  };
}

export class DeterministicExplanationGenerator implements IExplanationGenerator {
  isEnabled(): boolean {
    return true;
  }

  async generateExplanation(input: ExplanationInput): Promise<ExplanationOutput> {
    const { changeRecord, documentName, previousContent, newContent } = input;
    const reason = parseReason(changeRecord);

    switch (changeRecord.changeType) {
      case 'baseline':
        return createDeterministicExplanation(
          `Baseline established: ${reason.baselineDocCount || 0} documents indexed. This is the starting point for change monitoring.`,
          {
            what_changed: [
              `Initial document inventory captured (${reason.baselineDocCount || 0} documents)`,
              'All documents indexed for future change detection'
            ],
            why_it_matters: [
              'Establishes baseline for detecting future policy and procedure updates',
              'No policy changes occurred - this is the monitoring setup'
            ],
            recommended_actions: [
              'No action required - monitoring is now active',
              'Future changes will be tracked and explained'
            ],
          }
        );

      case 'renamed':
        const oldName = reason.oldName || 'unknown';
        const newName = reason.newName || documentName || 'unknown';
        return createDeterministicExplanation(
          `Document renamed from "${oldName}" to "${newName}".`,
          {
            what_changed: [`File name changed from "${oldName}" to "${newName}"`],
            why_it_matters: [
              'Renamed documents may indicate updated scope or purpose',
              'Training materials referencing the old name may need updates',
            ],
            recommended_actions: [
              'Update any references to the old document name',
              'Verify training materials use the correct document title',
            ],
          }
        );

      case 'deleted':
        const deletedName = reason.lastKnownName || documentName || 'Unknown document';
        const lastSeen = reason.lastSeenAt ? ` (last seen: ${new Date(reason.lastSeenAt).toLocaleDateString()})` : '';
        return createDeterministicExplanation(
          `Document "${deletedName}" removed from the monitored folder.${lastSeen}`,
          {
            what_changed: [`"${deletedName}" is no longer in the monitored folder`],
            why_it_matters: [
              'Document may have been intentionally deprecated',
              'Could indicate policy or procedure is no longer applicable',
              'Training content referencing this document may be outdated',
            ],
            recommended_actions: [
              'Verify if removal was intentional',
              'Check if document was moved to a different location',
              'Update training materials if document is deprecated',
            ],
          },
          { confidence: 'medium' }
        );

      case 'created':
        return this.generateCreatedExplanation(documentName, newContent);

      case 'modified':
        return this.generateModifiedExplanation(documentName, previousContent, newContent);

      default:
        return createDeterministicExplanation(
          `Change detected in document.`,
          {
            what_changed: ['Document change detected'],
            why_it_matters: ['Review may be required'],
            recommended_actions: ['Review the document for details'],
          },
          { confidence: 'low' }
        );
    }
  }

  protected generateCreatedExplanation(
    documentName?: string,
    content?: string
  ): ExplanationOutput {
    const name = documentName || 'New document';
    const hasContent = content && !content.startsWith('[') && content.length > 50;

    if (hasContent) {
      return createDeterministicExplanation(
        `New document "${name}" added to the tracked folder.`,
        {
          what_changed: [`New document "${name}" has been added`],
          why_it_matters: [
            'New policies or procedures may require training updates',
            'Staff may need to be informed of new documentation',
          ],
          recommended_actions: [
            'Review the new document content',
            'Determine if onboarding or training materials need updates',
            'Communicate new document availability to relevant teams',
          ],
        },
        { confidence: 'medium' }
      );
    }

    return createDeterministicExplanation(
      `New document "${name}" added. Content analysis not available.`,
      {
        what_changed: [`New document "${name}" detected`],
        why_it_matters: [
          'New documents may contain important policy information',
          'Content details require manual review (format not fully supported)',
        ],
        recommended_actions: [
          'Open the document directly to review its contents',
          'Assess if training materials need updates',
        ],
      },
      { confidence: 'low' }
    );
  }

  protected generateModifiedExplanation(
    documentName?: string,
    previousContent?: string,
    newContent?: string
  ): ExplanationOutput {
    const name = documentName || 'Document';
    const hasPrevious = previousContent && !previousContent.startsWith('[') && previousContent.length > 50;
    const hasNew = newContent && !newContent.startsWith('[') && newContent.length > 50;

    if (hasPrevious && hasNew) {
      const diffResult = computeTextDiffWithContext(previousContent!, newContent!, name);
      
      if (diffResult.isProcedural && diffResult.requirements.length > 0) {
        return this.generateSOPExplanation(name, diffResult);
      }
      
      return this.generateEvidenceBasedExplanation(name, diffResult);
    }

    return createDeterministicExplanation(
      `Document "${name}" has been modified. Detailed diff not available.`,
      {
        what_changed: [`"${name}" content has changed`],
        why_it_matters: [
          'Document modifications may affect policies or procedures',
          'Detailed comparison not available for this file format',
        ],
        recommended_actions: [
          'Open the document directly to review changes',
          'Compare with previous version if available',
        ],
      },
      { confidence: 'low' }
    );
  }

  protected generateSOPExplanation(
    documentName: string,
    diffResult: DiffResult
  ): ExplanationOutput {
    const { requirements, highRiskPhrases, hasHighRiskChanges } = diffResult;
    
    const sopRequirements: SOPRequirement[] = requirements.map(req => {
      let operationalImpact = '';
      
      switch (req.category) {
        case 'training':
          operationalImpact = 'Staff training programs may need to be updated or new training sessions scheduled';
          break;
        case 'system':
          operationalImpact = 'Employees must learn and use the specified system or tool';
          break;
        case 'storage':
          operationalImpact = 'Document handling and filing procedures must change';
          break;
        case 'step':
          operationalImpact = 'Workflow steps have changed - current procedures need updating';
          break;
        case 'responsibility':
          operationalImpact = 'Role responsibilities have been assigned or modified';
          break;
        default:
          operationalImpact = 'A new requirement or obligation has been introduced';
      }
      
      return {
        requirement: req.text,
        applies_to: req.appliesTo,
        what_is_new: this.describeNewRequirement(req),
        before_excerpt: req.beforeText,
        after_excerpt: req.afterText || req.text,
        operational_impact: operationalImpact,
        category: req.category,
        confidence: req.location ? 'high' : 'medium',
      };
    });
    
    const whatChanged = sopRequirements.map(req => req.what_is_new);
    
    const whyMatters: string[] = [];
    const trainingReqs = sopRequirements.filter(r => r.category === 'training');
    const systemReqs = sopRequirements.filter(r => r.category === 'system');
    const storageReqs = sopRequirements.filter(r => r.category === 'storage');
    
    if (trainingReqs.length > 0) {
      whyMatters.push(`${trainingReqs.length} new training requirement(s) identified`);
    }
    if (systemReqs.length > 0) {
      whyMatters.push(`${systemReqs.length} new system/tool usage requirement(s)`);
    }
    if (storageReqs.length > 0) {
      whyMatters.push(`${storageReqs.length} new document storage requirement(s)`);
    }
    if (hasHighRiskChanges) {
      whyMatters.push(`HIGH RISK: Contains compliance language (${highRiskPhrases.slice(0, 3).join(', ')})`);
    }
    if (whyMatters.length === 0) {
      whyMatters.push('Procedural requirements have been updated');
    }
    
    const recommendedActions: string[] = [];
    if (trainingReqs.length > 0) {
      recommendedActions.push('Schedule required training for affected staff');
    }
    if (systemReqs.length > 0) {
      recommendedActions.push('Ensure employees have access to required systems');
    }
    if (storageReqs.length > 0) {
      recommendedActions.push('Update document storage procedures');
    }
    recommendedActions.push('Review the full SOP for complete context');
    recommendedActions.push('Update onboarding materials to reflect new procedures');
    
    const title = `"${documentName}" SOP modified: ${sopRequirements.length} new/changed requirement(s)`;
    
    return createDeterministicExplanation(
      title,
      {
        what_changed: whatChanged,
        why_it_matters: whyMatters,
        recommended_actions: recommendedActions,
        new_or_changed_requirements: sopRequirements,
      },
      {
        confidence: 'high',
        highRiskDetected: hasHighRiskChanges,
        highRiskPhrases: highRiskPhrases,
        documentType: 'procedural',
      }
    );
  }

  protected describeNewRequirement(req: RequirementStatement): string {
    const categoryDescriptions: Record<string, string> = {
      training: 'New training requirement',
      system: 'New system/tool usage requirement',
      storage: 'New document storage requirement',
      step: 'New or modified procedure step',
      responsibility: 'New role responsibility assigned',
      obligation: 'New requirement or obligation',
    };
    
    const base = categoryDescriptions[req.category] || 'New requirement';
    
    if (req.appliesTo) {
      return `${base} for ${req.appliesTo}`;
    }
    
    return base;
  }

  protected generateEvidenceBasedExplanation(
    documentName: string,
    diffResult: DiffResult
  ): ExplanationOutput {
    const { chunks, summary, highRiskPhrases, hasHighRiskChanges } = diffResult;
    
    const changeItems: ChangeItem[] = chunks.map(chunk => {
      let plainEnglish = '';
      let whyMatters = '';
      let action = '';
      
      if (chunk.type === 'added') {
        plainEnglish = chunk.location 
          ? `New content added in "${chunk.location}" section`
          : 'New content added to document';
        whyMatters = 'New policy language may introduce new requirements or obligations';
        action = 'Review the added content for compliance implications';
      } else if (chunk.type === 'removed') {
        plainEnglish = chunk.location
          ? `Content removed from "${chunk.location}" section`
          : 'Content removed from document';
        whyMatters = 'Removed language may indicate deprecated procedures or reduced protections';
        action = 'Verify removal was intentional and update related training';
      } else {
        plainEnglish = chunk.location
          ? `Content modified in "${chunk.location}" section`
          : 'Content was revised';
        whyMatters = 'Modified language may change requirements, timelines, or responsibilities';
        action = 'Compare before and after text to understand the change';
      }

      const hrPhrases = chunk.after ? this.detectHighRiskInText(chunk.after) : [];
      if (hrPhrases.length > 0) {
        whyMatters = `HIGH RISK: Contains "${hrPhrases[0]}" language - may affect privacy/compliance`;
        action = 'Escalate for legal/compliance review immediately';
      }

      return {
        change_type: chunk.type,
        location: chunk.location,
        before_excerpt: chunk.before,
        after_excerpt: chunk.after,
        plain_english_change: plainEnglish,
        why_it_matters: whyMatters,
        recommended_action: action,
        confidence: chunk.location ? 'high' : 'medium',
      };
    });

    const whatChanged = changeItems.map(item => item.plain_english_change);
    if (whatChanged.length === 0) {
      whatChanged.push(`"${documentName}" content has changed`);
    }

    const whyMatters: string[] = [];
    if (hasHighRiskChanges) {
      whyMatters.push(`HIGH RISK: Contains privacy/compliance language (${highRiskPhrases.slice(0, 3).join(', ')})`);
    }
    whyMatters.push('Policy modifications may affect compliance requirements');
    if (summary.added > 0) whyMatters.push(`${summary.added} new section(s) added`);
    if (summary.removed > 0) whyMatters.push(`${summary.removed} section(s) removed`);

    const recommendedActions = [
      'Review all changed sections carefully',
      'Assess impact on training and onboarding materials',
    ];
    if (hasHighRiskChanges) {
      recommendedActions.unshift('Escalate to legal/compliance team for review');
    }

    const titlePrefix = hasHighRiskChanges ? '⚠️ HIGH RISK: ' : '';
    const title = `${titlePrefix}"${documentName}" modified with ${chunks.length} specific change(s)`;

    return createDeterministicExplanation(
      title,
      {
        what_changed: whatChanged,
        why_it_matters: whyMatters,
        recommended_actions: recommendedActions,
        change_items: changeItems,
      },
      {
        confidence: changeItems.length > 0 ? 'high' : 'medium',
        highRiskDetected: hasHighRiskChanges,
        highRiskPhrases: highRiskPhrases,
      }
    );
  }

  protected detectHighRiskInText(text: string): string[] {
    const phrases = [
      'sell', 'share', 'disclose', 'third party', 'transfer', 'retain', 'collect',
      'consent', 'opt out', 'opt-out', 'marketing', 'undisclosed', 'PII', 'personal data'
    ];
    const found: string[] = [];
    const lowerText = text.toLowerCase();
    for (const phrase of phrases) {
      if (lowerText.includes(phrase.toLowerCase())) {
        found.push(phrase);
      }
    }
    return [...new Set(found)];
  }
}

export class ReplitAIExplanationGenerator extends DeterministicExplanationGenerator {
  private openai: any = null;
  private readonly enabled: boolean;

  constructor() {
    super();
    this.enabled = process.env.EXPLANATIONS_ENABLED === 'true';
    
    if (this.enabled) {
      this.initializeOpenAI();
    }
  }

  private async initializeOpenAI() {
    try {
      const OpenAI = (await import('openai')).default;
      this.openai = new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });
    } catch (error) {
      console.error('Failed to initialize OpenAI client:', error);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async generateExplanation(input: ExplanationInput): Promise<ExplanationOutput> {
    const { changeRecord } = input;

    if (changeRecord.changeType === 'baseline' || changeRecord.changeType === 'renamed' || changeRecord.changeType === 'deleted') {
      return super.generateExplanation(input);
    }

    if (!this.enabled || !this.openai) {
      return super.generateExplanation(input);
    }

    try {
      return await this.generateAIExplanation(input);
    } catch (error) {
      console.error('AI explanation failed, falling back to deterministic:', error);
      return super.generateExplanation(input);
    }
  }

  private async generateAIExplanation(input: ExplanationInput): Promise<ExplanationOutput> {
    const { changeRecord, documentName, previousContent, newContent } = input;
    
    let diffContext = '';
    let diffChunks: any[] = [];
    let diffResult: DiffResult | null = null;
    
    if (changeRecord.changeType === 'modified' && previousContent && newContent) {
      diffResult = computeTextDiff(previousContent, newContent, 5);
      diffChunks = diffResult.chunks;
      
      if (diffChunks.length > 0) {
        diffContext = `\nDiff Chunks (prioritized by importance):\n${JSON.stringify(diffChunks, null, 2)}`;
      } else {
        const prevTrunc = previousContent.substring(0, 1000);
        const newTrunc = newContent.substring(0, 1000);
        diffContext = `\nPrevious content (truncated):\n${prevTrunc}\n\nNew content (truncated):\n${newTrunc}`;
      }
    } else if (changeRecord.changeType === 'created' && newContent) {
      const truncated = newContent.substring(0, 2000);
      diffContext = `\nNew document content (truncated):\n${truncated}`;
    }

    const prompt = `You are analyzing a document change for an organization's policy and procedure tracking system.
Provide evidence-based, specific explanations for stakeholders (HR, compliance, operations managers).

Document: "${documentName || 'Unknown'}"
Change Type: ${changeRecord.changeType}
${diffContext}

IMPORTANT: You MUST output valid JSON matching this EXACT schema:
{
  "title": "Brief one-line summary (include ⚠️ HIGH RISK prefix if privacy/compliance terms detected)",
  "change_items": [
    {
      "change_type": "added" | "removed" | "modified",
      "location": "Section name if known, or null",
      "before_excerpt": "Original text excerpt (<=30 words) or null if added",
      "after_excerpt": "New text excerpt (<=30 words) or null if removed",
      "plain_english_change": "What specifically changed in plain language",
      "why_it_matters": "Why this matters for compliance/training",
      "recommended_action": "Specific action to take",
      "confidence": "low" | "medium" | "high"
    }
  ],
  "summary": {
    "what_changed": ["bullet 1", "bullet 2"],
    "why_it_matters": ["bullet 1", "bullet 2"],
    "recommended_actions": ["action 1", "action 2"]
  },
  "overall_confidence": "low" | "medium" | "high",
  "high_risk_detected": true | false
}

RULES:
- Every change_item MUST have before_excerpt and/or after_excerpt from the actual text
- Do NOT invent facts - only describe what you see in the excerpts
- Flag any text containing: sell, share, disclose, third party, transfer, consent, opt out, marketing, undisclosed, PII, personal data
- Keep excerpts under 30 words
- 3-8 change_items max, prioritize most important changes
- If you cannot identify specific changes, say so honestly`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_completion_tokens: 1000,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from AI');
    }

    const parsed = JSON.parse(content);
    
    return {
      text: parsed.title || 'Document change detected',
      bullets: {
        what_changed: parsed.summary?.what_changed || [],
        why_it_matters: parsed.summary?.why_it_matters || [],
        recommended_actions: parsed.summary?.recommended_actions || [],
        change_items: parsed.change_items || [],
      },
      meta: {
        model: 'gpt-4o-mini',
        promptVersion: 'evidence-v2',
        inputsUsed: ['documentName', 'changeType', 'diffChunks'],
        confidence: parsed.overall_confidence || 'medium',
        deterministic: false,
        highRiskDetected: parsed.high_risk_detected || false,
        highRiskPhrases: diffResult?.highRiskPhrases || [],
      },
    };
  }
}

export async function generateAndStoreExplanation(
  changeRecordId: string,
  generator: IExplanationGenerator,
  input: ExplanationInput
): Promise<void> {
  const startTime = Date.now();
  
  try {
    const output = await generator.generateExplanation(input);
    
    const status = generator.isEnabled() || 
      input.changeRecord.changeType === 'baseline' || 
      input.changeRecord.changeType === 'renamed' ||
      input.changeRecord.changeType === 'deleted'
        ? 'generated' 
        : 'skipped';
    
    await db.updateChangeRecordExplanation(changeRecordId, {
      explanationText: output.text,
      explanationBullets: JSON.stringify(output.bullets),
      explanationMeta: JSON.stringify(output.meta),
      explanationStatus: status,
      explainedAt: new Date().toISOString(),
    });

    console.log(`✅ Explanation ${status} for ${changeRecordId} in ${Date.now() - startTime}ms`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ Explanation failed for ${changeRecordId}:`, errorMessage);
    
    try {
      const fallbackGen = new DeterministicExplanationGenerator();
      const fallbackOutput = await fallbackGen.generateExplanation(input);
      
      await db.updateChangeRecordExplanation(changeRecordId, {
        explanationText: fallbackOutput.text,
        explanationBullets: JSON.stringify(fallbackOutput.bullets),
        explanationMeta: JSON.stringify({ ...fallbackOutput.meta, fallbackFromError: true }),
        explanationStatus: 'generated',
        explanationError: `AI failed: ${errorMessage}`,
        explainedAt: new Date().toISOString(),
      });
      console.log(`✅ Fallback explanation stored for ${changeRecordId}`);
    } catch (fallbackError) {
      await db.updateChangeRecordExplanation(changeRecordId, {
        explanationStatus: 'failed',
        explanationError: errorMessage,
        explainedAt: new Date().toISOString(),
      });
    }
  }
}

export async function backfillNullExplanations(): Promise<number> {
  const records = await db.getChangeRecordsWithNullExplanations();
  let backfilled = 0;
  
  const generator = new DeterministicExplanationGenerator();
  
  for (const record of records) {
    try {
      let reason: ChangeReason = {};
      if (record.reason) {
        try {
          reason = JSON.parse(record.reason);
        } catch {}
      }
      
      const input: ExplanationInput = {
        changeRecord: record,
        documentName: reason.lastKnownName || reason.newName,
        reason,
      };
      
      const output = await generator.generateExplanation(input);
      
      await db.updateChangeRecordExplanation(record.id, {
        explanationText: output.text,
        explanationBullets: JSON.stringify(output.bullets),
        explanationMeta: JSON.stringify({ ...output.meta, backfilled: true }),
        explanationStatus: 'generated',
        explainedAt: new Date().toISOString(),
      });
      
      backfilled++;
    } catch (err) {
      console.error(`Failed to backfill explanation for ${record.id}:`, err);
    }
  }
  
  if (backfilled > 0) {
    console.log(`📋 Backfilled ${backfilled} null explanation records`);
  }
  
  return backfilled;
}

let explanationGeneratorInstance: IExplanationGenerator | null = null;

export function getExplanationGenerator(): IExplanationGenerator {
  if (!explanationGeneratorInstance) {
    explanationGeneratorInstance = new ReplitAIExplanationGenerator();
  }
  return explanationGeneratorInstance;
}
