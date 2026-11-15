import { readFileSync } from 'node:fs';
import { z } from 'zod';

const manifestSchema = z.object({
  version: z.string().min(1),
  chatMain: z.object({ model: z.string().min(1), streaming: z.literal(true), contextTokens: z.number().int().min(32_000), maxOutputTokens: z.literal(1024) }),
});
export function loadCapabilities(path: string, model: string) {
  try {
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    if (manifest.chatMain.model !== model) return { error: 'CHAT_MAIN_MODEL does not match the capability manifest.' } as const;
    return { manifest } as const;
  } catch {
    return { error: 'Configure a valid streaming chat capability manifest with sufficient context.' } as const;
  }
}
