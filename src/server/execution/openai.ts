import OpenAI from 'openai';
import type { ChatProvider } from './chat';

export function createOpenAIProvider(): ChatProvider {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_NOT_CONFIGURED');
  // An ambiguous failure must never result in another automatically billed call.
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 90000 });
  return async (request, signal) => client.responses.create(request, { signal });
}
