export type BudgetedMessage = { role: string; content: unknown };
export type ContextBudget = { contextTokens: number; outputTokens: number; safetyTokens: number };

export class ContextBudgetError extends Error {
  constructor() { super('Prompt exceeds the configured context envelope after bounded compaction.'); this.name = 'ContextBudgetError'; }
}

/** Count serialized UTF-8 bytes as a conservative, tokenizer-independent budget cost. */
export function serializedPromptBudgetCost(messages: unknown[], extraPayloads: unknown[] = []) {
  const serialized = JSON.stringify({ messages, extraPayloads });
  return Buffer.byteLength(serialized, 'utf8') + messages.length * 8;
}

export function assertPromptBudget(messages: unknown[], budget: ContextBudget, extraPayloads: unknown[] = []) {
  const inputCost = serializedPromptBudgetCost(messages, extraPayloads);
  const availableCost = budget.contextTokens - budget.outputTokens - budget.safetyTokens;
  if (inputCost > availableCost) throw new ContextBudgetError();
  return { inputCost, availableCost };
}

/** Drop only oldest complete user/assistant pairs; preserve system instructions and the current user request. */
export function compactChatMessages<T extends BudgetedMessage>(messages: T[], budget: ContextBudget, extraPayloads: unknown[] = []) {
  return compactByRoles(messages, messages.map(message => message.role), budget, extraPayloads);
}

export function compactSerializedMessages<T>(messages: T[], roles: string[], budget: ContextBudget, extraPayloads: unknown[] = []) {
  return compactByRoles(messages, roles, budget, extraPayloads);
}

function compactByRoles<T>(messages: T[], roles: string[], budget: ContextBudget, extraPayloads: unknown[]) {
  if (messages.length !== roles.length) throw new Error('Message role map mismatch');
  const result = [...messages], selectedRoles = [...roles];
  let currentIndex = selectedRoles.lastIndexOf('user');
  if (currentIndex < 0) throw new ContextBudgetError();
  const availableCost = budget.contextTokens - budget.outputTokens - budget.safetyTokens;
  let inputCost = serializedPromptBudgetCost(result, extraPayloads), removedPairs = 0;
  for (let i = 0; inputCost > availableCost && i < currentIndex - 1;) {
    if (selectedRoles[i] !== 'user' || selectedRoles[i + 1] !== 'assistant') { i++; continue; }
    const removedBytes = Buffer.byteLength(JSON.stringify(result[i]), 'utf8') + Buffer.byteLength(JSON.stringify(result[i + 1]), 'utf8') + 2 + 16;
    result.splice(i, 2); selectedRoles.splice(i, 2); currentIndex -= 2;
    inputCost -= removedBytes; removedPairs++;
  }
  const measured = assertPromptBudget(result, budget, extraPayloads);
  return { messages: result, removedPairs, ...measured };
}

export function serializableMessages(messages: { toJSON?: () => unknown; role?: string; content?: unknown }[]) {
  return messages.map(message => typeof message.toJSON === 'function' ? message.toJSON() : { role: message.role, content: message.content });
}
