import { z } from 'zod';

const uuid = z.uuid();
const memoryKind = z.enum(['preference', 'role_context', 'working_context']);

export const memoryCreateInput = z.object({
  botId: uuid.nullable().default(null),
  kind: memoryKind,
  content: z.string().trim().min(1).max(4000),
  provenance: z.string().trim().min(1).max(500),
  sourceContext: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).default({}),
  idempotencyKey: uuid,
}).strict();

export const memoryUpdateInput = memoryCreateInput.omit({idempotencyKey:true}).extend({
  expectedVersion: z.number().int().positive(),
}).strict();

export const groupCreateInput = z.object({
  name: z.string().trim().min(1).max(80),
  idempotencyKey: uuid,
}).strict();

export const groupUpdateInput = z.object({name:z.string().trim().min(1).max(80)}).strict();

export const handoffCreateInput = z.object({
  rootRunId: uuid,
  parentHandoffId: uuid.nullable().default(null),
  sourceBotId: uuid,
  targetBotId: uuid,
  groupId: uuid.nullable().default(null),
  task: z.string().trim().min(1).max(8000),
  sourceMessageIds: z.array(uuid).max(20).default([]),
  budgetMicros: z.number().int().positive().max(250_000),
  idempotencyKey: uuid,
}).strict();

export const collaborationLimits = {
  maxHandoffDepth: 3,
  maxSourceMessages: 20,
  maxMemoryContextBytes: 4_000,
} as const;

export type MemoryCreate = z.infer<typeof memoryCreateInput>;
export type MemoryUpdate = z.infer<typeof memoryUpdateInput>;
export type HandoffCreate = z.infer<typeof handoffCreateInput>;

export type CollaborationError = {
  status: number;
  message: string;
};

const errors: Record<string, CollaborationError> = {
  MEMORY_NOT_FOUND: {status:404,message:'Memória não encontrada.'},
  MEMORY_DELETED: {status:409,message:'Esta memória foi removida. Use uma nova chave para salvar outra.'},
  GROUP_NOT_FOUND: {status:404,message:'Grupo não encontrado.'},
  HANDOFF_NOT_FOUND: {status:404,message:'Delegação não encontrada.'},
  BOT_NOT_FOUND: {status:404,message:'Contato não encontrado.'},
  RUN_NOT_FOUND: {status:404,message:'Tarefa não encontrada.'},
  MESSAGE_NOT_FOUND: {status:404,message:'Contexto não encontrado.'},
  VERSION_CONFLICT: {status:409,message:'A memória mudou. Atualize e tente novamente.'},
  IDEMPOTENCY_CONFLICT: {status:409,message:'Esta chave já foi usada com outros dados.'},
  HANDOFF_CYCLE: {status:409,message:'Esta delegação criaria um ciclo.'},
  HANDOFF_DEPTH: {status:409,message:'A delegação atingiu o limite de profundidade.'},
  HANDOFF_BUDGET: {status:429,message:'A tarefa não tem orçamento reservado para esta delegação.'},
  ROOT_CANCELLED: {status:409,message:'A tarefa principal foi interrompida.'},
  ROOT_FINISHED: {status:409,message:'A tarefa principal já terminou.'},
  PARENT_NOT_DELIVERED: {status:409,message:'A delegação anterior ainda não foi entregue.'},
  GROUP_MEMBER_REQUIRED: {status:409,message:'O bot não participa mais deste grupo.'},
  INVALID_MEMORY: {status:400,message:'Confira os dados da memória.'},
  INVALID_GROUP: {status:400,message:'Confira os dados do grupo.'},
  INVALID_HANDOFF: {status:400,message:'Confira os dados da delegação.'},
};

export function collaborationError(message: string, fallback = 'Não foi possível concluir esta operação.'): CollaborationError {
  const match = Object.entries(errors).find(([code]) => message.includes(code));
  return match?.[1] ?? {status:500,message:fallback};
}
