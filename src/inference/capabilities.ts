import { readFileSync } from 'node:fs';
import { z } from 'zod';

const mainSchema = z.object({
  model: z.string().min(1), streaming: z.literal(true),
  contextTokens: z.number().int().min(32_000), maxOutputTokens: z.literal(1024),
}).strict();
const fallbackSchema = z.object({
  model: z.string().min(1), streaming: z.literal(true), toolCalls: z.literal(true), promptedJson: z.literal(true),
  contextTokens: z.number().int().min(4096), maxOutputTokens: z.literal(1024),
  verification: z.object({ streaming: z.literal('passed'), researchContract: z.literal('passed'), backendRoute: z.string().min(1), checkedAt: z.string().datetime() }).strict(),
}).strict();
const manifestSchema = z.object({
  version: z.string().min(1), chatMain: mainSchema, chatFallback: z.unknown().optional(),
}).strict();

export type ResearchFallbackCapability = z.infer<typeof fallbackSchema>;

export function loadCapabilities(path: string, model: string, fallbackModel = 'chat-fast-v1', fallbackRoute?: string) {
  try {
    const parsed = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (parsed.chatMain.model !== model) return { error: 'CHAT_MAIN_MODEL does not match the capability manifest.' } as const;
    let fallback: ResearchFallbackCapability | undefined;
    if (parsed.chatFallback !== undefined) {
      const candidate = fallbackSchema.parse(parsed.chatFallback);
      if (candidate.model !== fallbackModel) return { error: 'CHAT_FAST_MODEL does not match the verified fallback capability.' } as const;
      if (!fallbackRoute || candidate.verification.backendRoute !== fallbackRoute) return { error: 'The configured fast backend route does not match the verified fallback capability.' } as const;
      if (candidate.model === model) return { error: 'The research fallback must use a separate model route.' } as const;
      if (candidate.contextTokens >= parsed.chatMain.contextTokens) return { error: 'The fallback context must be smaller than the main model context.' } as const;
      fallback = candidate;
    }
    return { manifest: { version: parsed.version, chatMain: parsed.chatMain }, fallback } as const;
  } catch {
    return { error: 'Configure a valid streaming main-model manifest and, if present, a verified compatible research fallback.' } as const;
  }
}
