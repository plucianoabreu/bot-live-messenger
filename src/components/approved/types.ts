import type { Bot, Message } from '@/domain/bots';
import type { RunSummary } from '@/domain/runs';
export type RuntimeOptions = {
 authConfigured?: boolean;
 recovery?: boolean;
 initialError?: string;
 preview?: boolean;
 live?: boolean;
 bots?: Bot[];
 messages?: Record<string,Message[]>;
 userName?: string;
 userId?: string;
 userAvatarId?: string;
 runsEnabled?: boolean;
 watchEnabled?: boolean;
 runs?: Record<string,RunSummary>;
 /** Transitional compatibility for callers created before canonical run reads. */
 activeRuns?: Record<string,{id:string;cancel_requested:boolean;state?:RunSummary['state']}>;
 refresh?: ()=>void;
};
