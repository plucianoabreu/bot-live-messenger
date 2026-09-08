import catalog from './presets.json';
import { pictureUrl } from './profiles';
export const presets = catalog.map(preset=>({...preset,avatar:pictureUrl(preset.avatarId)}));
export type ComputerState = 'NOT_CREATED' | 'CREATING' | 'READY' | 'PAUSED' | 'RESUMING' | 'FAILED';
export type RunState = 'QUEUED' | 'RUNNING' | 'WAITING_FOR_USER' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export type Presence = 'available' | 'busy' | 'away' | 'offline';
export function presence(computer: ComputerState, run?: RunState, enabled = true): Presence {
  if (!enabled || computer === 'FAILED') return 'offline';
  if (run === 'QUEUED' || run === 'RUNNING') return 'busy';
  if (run === 'WAITING_FOR_USER') return 'away';
  if (computer === 'PAUSED') return 'away';
  if (computer === 'CREATING' || computer === 'RESUMING') return 'busy';
  return 'available'; // No computer yet is still ready to accept work.
}
export const presenceLabels = {available: 'Disponível', busy: 'Ocupado', away: 'Ausente', offline: 'Offline'};
export type Bot = {id: string; name: string; preset: string|null; description: string; role: string; instructions: string; instructions_version:number; avatar_id:string; computer_state: ComputerState; enabled: boolean; run_state?: RunState};
export type DeliveredArtifact = {id:string;name:string;mime_type:string;size_bytes:number};
export type Message = {id: string; sequence?: string; run_id?:string|null; role: 'user' | 'assistant' | 'system'; content: string; created_at: string; artifacts?:DeliveredArtifact[]};
