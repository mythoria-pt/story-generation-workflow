import { validateInterviewPhoto } from './photos.js';
const projectId = '11111111-1111-4111-8111-111111111111';
const participantId = '22222222-2222-4222-8222-222222222222';
const asset = {
  objectPath: `biographer/${projectId}/${participantId}/photos/photo-id`,
  contentType: 'image/jpeg' as const,
  participantId,
};
describe('interview photograph ownership', () => {
  it('accepts the private project/participant reference', () => {
    expect(() => validateInterviewPhoto(projectId, asset)).not.toThrow();
  });
  it('rejects other projects, directory traversal and extra path components', () => {
    expect(() => validateInterviewPhoto('another-project', asset)).toThrow();
    expect(() =>
      validateInterviewPhoto(projectId, { ...asset, objectPath: asset.objectPath + '/../other' }),
    ).toThrow();
    expect(() =>
      validateInterviewPhoto(projectId, { ...asset, objectPath: asset.objectPath + '/nested' }),
    ).toThrow();
  });
});
