import { z } from 'zod';
import pictures from './display-pictures.json';

export const displayPictures: readonly string[] = pictures;
export const defaultPicture = '0c5319e7147890e45265faad3b17701c1de71b12.png';
export function pictureUrl(id?: string, reducedMotion = false) {
  const file = id && displayPictures.includes(id) ? id : defaultPicture;
  return `/assets/display-pictures/${reducedMotion && file.endsWith('.gif') ? `still/${file}.png` : file}`;
}
const avatarId = z.string().refine(value => displayPictures.includes(value), 'INVALID_PICTURE');
export const botProfileInput = z.object({
  name: z.string().trim().min(5).max(80).regex(/^AI\s+\S.*\s+\S/),
  role: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(140),
  instructions: z.string().trim().min(1).max(4000),
  avatarId,
}).strict();
export const createBotInput = botProfileInput.extend({idempotencyKey:z.uuid()});
export const profileInput = z.object({avatarId}).strict();
export type UserProfile = {user_id:string; avatar_id:string; locale:string};
