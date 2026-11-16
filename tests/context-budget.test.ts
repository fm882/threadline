import { it, expect } from 'vitest';
import { assertPromptBudget, compactChatMessages, compactSerializedMessages, ContextBudgetError, promptTokenUpperBound } from '../src/research/context-budget.js';

it('compacts only complete oldest user/assistant pairs and preserves systems and the current request', () => {
  const messages = [
    { role: 'system', content: 'Keep the source evidence and required subject Acme CRM.' },
    { role: 'user', content: 'old request '.repeat(500) },
    { role: 'assistant', content: 'old response '.repeat(500) },
    { role: 'user', content: 'current question about Acme CRM' },
  ];
  const compiled = compactChatMessages(messages, { contextTokens: 6000, outputTokens: 1000, safetyTokens: 500 });
  expect(compiled.removedPairs).toBe(1);
  expect(compiled.messages.map(message => message.content)).toEqual([messages[0].content, messages[3].content]);
  expect(compiled.inputTokens).toBeLessThanOrEqual(compiled.availableTokens);
});

it('bounds a thousand distracting exchanges without dropping the protected subject list', () => {
  const messages = [{ role: 'system', content: 'Requested subjects: Acme CRM, Northstar CRM, Copper CRM, Folk CRM, Twenty CRM.' }];
  for (let index = 0; index < 1000; index++) messages.push({ role: 'user', content: `Unrelated historical question ${index} `.repeat(12) }, { role: 'assistant', content: `Unrelated historical answer ${index} `.repeat(12) });
  messages.push({ role: 'user', content: 'Compare all five requested CRM products.' });
  const compiled = compactChatMessages(messages, { contextTokens: 7000, outputTokens: 1024, safetyTokens: 2048 });
  expect(compiled.removedPairs).toBeGreaterThan(900);
  expect(compiled.messages[0].content).toContain('Twenty CRM');
  expect(compiled.messages.at(-1)?.content).toBe('Compare all five requested CRM products.');
  expect(compiled.inputTokens).toBeLessThanOrEqual(3928);
});

it('counts schemas, tool results, message frames, and output reserve in the request envelope', () => {
  const messages = [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'question' }];
  const plain = promptTokenUpperBound(messages);
  const withSchema = promptTokenUpperBound(messages, [{ tool: 'web_search', schema: 'x'.repeat(2000) }]);
  expect(withSchema).toBeGreaterThan(plain);
  expect(() => assertPromptBudget(messages, { contextTokens: 4000, outputTokens: 1024, safetyTokens: 2048 }, [{ tool: 'large', schema: 'x'.repeat(2000) }])).toThrow(ContextBudgetError);
});

it('keeps the current tool-call and result pair intact while dropping earlier complete exchanges', () => {
  const messages = [
    { type: 'system', content: 'rules' },
    { type: 'human', content: 'old question '.repeat(200) },
    { type: 'ai', content: 'old answer '.repeat(200) },
    { type: 'human', content: 'current query' },
    { type: 'ai', tool_calls: [{ id: 'call_1', name: 'web_search' }] },
    { type: 'tool', tool_call_id: 'call_1', content: 'short result' },
    { type: 'system', content: 'return structured output' },
  ];
  const roles = ['system', 'user', 'assistant', 'user', 'assistant', 'tool', 'system'];
  const compiled = compactSerializedMessages(messages, roles, { contextTokens: 6000, outputTokens: 1000, safetyTokens: 500 }, [{ schema: 'tool definition' }]);
  expect(compiled.removedPairs).toBe(1);
  expect(compiled.messages).toEqual([messages[0], messages[3], messages[4], messages[5], messages[6]]);
});

it('raises a typed visible-limit condition when required instructions or the current request cannot fit', () => {
  const messages = [{ role: 'system', content: 'source provenance '.repeat(200) }, { role: 'user', content: 'must retain this question' }];
  expect(() => compactChatMessages(messages, { contextTokens: 3500, outputTokens: 1024, safetyTokens: 2048 })).toThrow(ContextBudgetError);
});
