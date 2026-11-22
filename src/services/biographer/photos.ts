import { Storage } from '@google-cloud/storage';
import type { InterviewRequest } from './contract.js';

export function validateInterviewPhoto(
  projectId: string,
  asset: NonNullable<InterviewRequest['photoReferences']>[number],
) {
  const prefix = `biographer/${projectId}/${asset.participantId}/photos/`;
  if (
    !asset.objectPath.startsWith(prefix) ||
    asset.objectPath.includes('..') ||
    asset.objectPath.slice(prefix.length).includes('/')
  )
    throw new Error('INVALID_INTERVIEW_PHOTO');
}
export async function loadInterviewPhotos(
  input: Pick<InterviewRequest, 'projectId' | 'photoReferences'>,
) {
  const mediaParts: Array<{ mimeType: string; data: Buffer }> = [];
  for (const asset of input.photoReferences ?? []) {
    validateInterviewPhoto(input.projectId, asset);
    const name = process.env.BIOGRAPHER_STORAGE_BUCKET;
    if (!name) throw new Error('PRIVATE_PHOTO_STORAGE_UNAVAILABLE');
    const file = new Storage().bucket(name).file(asset.objectPath);
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size) > 10485760) throw new Error('INTERVIEW_PHOTO_TOO_LARGE');
    const [data] = await file.download();
    mediaParts.push({ mimeType: asset.contentType, data });
  }
  return mediaParts;
}
