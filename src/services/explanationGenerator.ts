import { 
  ChangeRecord, 
  ChangeReason, 
  ExplanationInput, 
  ExplanationOutput, 
  ExplanationBullets, 
  ExplanationMeta 
} from '../types';
import { db } from '../db';

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
  confidence: 'low' | 'medium' | 'high' = 'high'
): ExplanationOutput {
  return {
    text,
    bullets,
    meta: {
      deterministic: true,
      confidence,
      promptVersion: 'deterministic-v1',
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
          `Baseline established with ${reason.baselineDocCount || 0} documents indexed for change tracking.`,
          {
            what_changed: ['Initial document inventory captured', 'All documents indexed for future change detection'],
            why_it_matters: ['Establishes baseline for detecting future policy and procedure updates'],
            recommended_actions: ['No action required - monitoring is now active'],
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
        return createDeterministicExplanation(
          `Document "${deletedName}" was removed from the tracked folder.`,
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
          'medium'
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
          'low'
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
        'medium'
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
      'low'
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
      const summary = this.computeBasicDiffSummary(previousContent!, newContent!);
      return createDeterministicExplanation(
        `Document "${name}" content has been modified. ${summary}`,
        {
          what_changed: [
            `Content of "${name}" has changed`,
            summary,
          ],
          why_it_matters: [
            'Policy or procedure changes may affect compliance requirements',
            'Training materials may need to reflect new content',
            'Staff awareness of changes may be required',
          ],
          recommended_actions: [
            'Review the updated document to understand changes',
            'Assess impact on existing training and onboarding',
            'Communicate significant changes to affected teams',
          ],
        },
        'medium'
      );
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
      'low'
    );
  }

  protected computeBasicDiffSummary(previous: string, current: string): string {
    const prevLength = previous.length;
    const currLength = current.length;
    const diff = currLength - prevLength;

    if (Math.abs(diff) < 50) {
      return 'Minor text edits detected.';
    } else if (diff > 500) {
      return 'Significant content added.';
    } else if (diff < -500) {
      return 'Significant content removed.';
    } else if (diff > 0) {
      return 'Content expanded.';
    } else {
      return 'Content reduced.';
    }
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

    if (changeRecord.changeType === 'baseline' || changeRecord.changeType === 'renamed') {
      return super.generateExplanation(input);
    }

    if (!this.enabled || !this.openai) {
      return super.generateExplanation(input);
    }

    try {
      return await this.generateAIExplanation(input);
    } catch (error) {
      console.error('AI explanation failed, falling back to deterministic:', error);
      throw error;
    }
  }

  private async generateAIExplanation(input: ExplanationInput): Promise<ExplanationOutput> {
    const { changeRecord, documentName, previousContent, newContent } = input;
    
    let contentContext = '';
    if (changeRecord.changeType === 'created' && newContent) {
      const truncated = newContent.substring(0, 2000);
      contentContext = `New document content (truncated):\n${truncated}`;
    } else if (changeRecord.changeType === 'modified' && previousContent && newContent) {
      const prevTrunc = previousContent.substring(0, 1000);
      const newTrunc = newContent.substring(0, 1000);
      contentContext = `Previous content (truncated):\n${prevTrunc}\n\nNew content (truncated):\n${newTrunc}`;
    } else if (changeRecord.changeType === 'deleted') {
      contentContext = `Document was removed from the tracked folder.`;
    }

    const prompt = `You are analyzing a document change for an organization's policy and procedure tracking system. 
Provide a plain-English explanation for stakeholders (HR, compliance, operations managers).

Document: "${documentName || 'Unknown'}"
Change Type: ${changeRecord.changeType}
${contentContext}

Respond with JSON only:
{
  "title": "Brief one-line summary",
  "what_changed": ["bullet 1", "bullet 2", "bullet 3"],
  "why_it_matters": ["bullet 1", "bullet 2"],
  "recommended_actions": ["action 1", "action 2"],
  "confidence": "low" | "medium" | "high"
}

Rules:
- Keep bullets concise (under 20 words each)
- Use plain language, no jargon
- Be specific about what changed
- If content is unclear or truncated, say "may" or "appears to"
- 2-4 bullets per section`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      max_completion_tokens: 500,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from AI');
    }

    const parsed = JSON.parse(content);
    
    return {
      text: parsed.title || 'Document change detected',
      bullets: {
        what_changed: parsed.what_changed || [],
        why_it_matters: parsed.why_it_matters || [],
        recommended_actions: parsed.recommended_actions || [],
      },
      meta: {
        model: 'gpt-4o-mini',
        promptVersion: 'v1',
        inputsUsed: ['documentName', 'changeType', contentContext ? 'content' : undefined].filter(Boolean) as string[],
        confidence: parsed.confidence || 'medium',
        deterministic: false,
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
    if (!generator.isEnabled() && 
        input.changeRecord.changeType !== 'baseline' && 
        input.changeRecord.changeType !== 'renamed') {
      const deterministicGen = new DeterministicExplanationGenerator();
      const output = await deterministicGen.generateExplanation(input);
      
      await db.updateChangeRecordExplanation(changeRecordId, {
        explanationText: output.text,
        explanationBullets: JSON.stringify(output.bullets),
        explanationMeta: JSON.stringify({ ...output.meta, skippedAI: true }),
        explanationStatus: 'skipped',
        explainedAt: new Date().toISOString(),
      });
      return;
    }

    const output = await generator.generateExplanation(input);
    
    await db.updateChangeRecordExplanation(changeRecordId, {
      explanationText: output.text,
      explanationBullets: JSON.stringify(output.bullets),
      explanationMeta: JSON.stringify(output.meta),
      explanationStatus: 'generated',
      explainedAt: new Date().toISOString(),
    });

    console.log(`✅ Explanation generated for ${changeRecordId} in ${Date.now() - startTime}ms`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`❌ Explanation failed for ${changeRecordId}:`, errorMessage);
    
    await db.updateChangeRecordExplanation(changeRecordId, {
      explanationStatus: 'failed',
      explanationError: errorMessage,
      explainedAt: new Date().toISOString(),
    });
  }
}

let explanationGeneratorInstance: IExplanationGenerator | null = null;

export function getExplanationGenerator(): IExplanationGenerator {
  if (!explanationGeneratorInstance) {
    explanationGeneratorInstance = new ReplitAIExplanationGenerator();
  }
  return explanationGeneratorInstance;
}
