import { z } from 'zod';
import type { RunState } from './bots';
export const messageInput = z.object({content: z.string().trim().min(1).max(8000), idempotencyKey: z.uuid(), kind: z.enum(['chat','computer']).default('chat')}).strict();
export const terminalStates: RunState[] = ['SUCCEEDED','FAILED','CANCELLED'];
export type RunSummary = {
  id: string;
  bot_id: string;
  kind: 'chat' | 'computer';
  state: RunState;
  cancel_requested: boolean;
  error_code: string | null;
  created_at: string;
  finished_at: string | null;
};
export const activeRunStates: RunState[] = ['QUEUED','RUNNING','WAITING_FOR_USER'];
export function isActiveRun(run?: Pick<RunSummary,'state'> | null) {return Boolean(run && activeRunStates.includes(run.state));}
export function livePollInterval(runs?: Record<string,Pick<RunSummary,'state'>>) {
  return Object.values(runs??{}).some(isActiveRun) ? 2000 : 10000;
}
export function parseSequencePage(searchParams: URLSearchParams, defaultLimit=50, maxLimit=100) {
  const rawCursor=searchParams.get('after')??'0';
  const rawLimit=searchParams.get('limit')??String(defaultLimit);
  if(!/^\d{1,20}$/.test(rawCursor))throw new Error('INVALID_CURSOR');
  if(!/^\d{1,3}$/.test(rawLimit))throw new Error('INVALID_LIMIT');
  if(BigInt(rawCursor)>9_223_372_036_854_775_807n)throw new Error('INVALID_CURSOR');
  const limit=Number(rawLimit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>maxLimit)throw new Error('INVALID_LIMIT');
  return {after:rawCursor.replace(/^0+(?=\d)/,''),limit};
}
const transitions: Record<RunState, RunState[]> = {
  QUEUED: ['RUNNING','FAILED','CANCELLED'], RUNNING: ['WAITING_FOR_USER','SUCCEEDED','FAILED','CANCELLED'],
  WAITING_FOR_USER: ['CANCELLED','FAILED'], SUCCEEDED: [], FAILED: [], CANCELLED: [],
};
export function canTransition(from: RunState, to: RunState) {return transitions[from].includes(to);}
export const limits = {welcomeChatMessages:8,welcomeComputerRuns:1,maxSeconds:120,maxTurns:20,maxActions:60,maxCostMicros:250_000,chatCostMicros:20_000,chatPoolMicros:30_000_000,computerPoolMicros:10_000_000,reserveMicros:10_000_000} as const;
export function withinBudget(spentMicros: number, nextReservationMicros: number, kind: 'chat' | 'computer' = 'computer') {
  return Number.isSafeInteger(spentMicros) && Number.isSafeInteger(nextReservationMicros) && spentMicros >= 0 && nextReservationMicros >= 0 && spentMicros + nextReservationMicros <= (kind === 'chat' ? limits.chatCostMicros : limits.maxCostMicros);
}
