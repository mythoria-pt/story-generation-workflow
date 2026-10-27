import { readFileSync } from 'fs';
import { join } from 'path';

describe('Audiobook workflow retry contract', () => {
  const workflow = readFileSync(
    join(process.cwd(), 'workflows', 'audiobook-generation.yaml'),
    'utf8',
  );
  const audioRoute = readFileSync(join(process.cwd(), 'src', 'routes', 'audio.ts'), 'utf8');
  const internalRoute = readFileSync(join(process.cwd(), 'src', 'routes', 'internal.ts'), 'utf8');

  it('defaults to an empty voice so SGW resolves it per audience, and bounds layered retries', () => {
    expect(workflow).toContain('voice: ${default(map.get(payload, "voice"), "")}');
    expect(workflow).toContain(
      'includeBackgroundMusic: ${default(map.get(payload, "includeBackgroundMusic"), true)}',
    );
    expect(workflow).not.toContain('default(payload.voice');
    expect(workflow).toContain('voice: ${voice}');
    expect(workflow).toContain('chapterAudioMaxAttempts: 2');
    expect(audioRoute).toContain(
      "const selectedVoice = isAutoVoice(requestedVoice) ? '' : requestedVoice;",
    );
    expect(audioRoute).not.toContain('getTTSConfig().voice');
    // Chapter routes forward the raw voice; TTSService resolves empty/'auto'
    expect(internalRoute).toMatch(
      /generateChapterAudioFromText\(\s*storyId,\s*chapterNumber,\s*chapterContent,\s*storyTitle[^,]*,\s*voice,/,
    );
    expect(audioRoute).not.toContain("voice: voice || 'coral'");
    expect(audioRoute).not.toContain("voice: voice || 'nova'");
  });

  it('stops non-retryable chapter failures and fails the workflow execution', () => {
    expect(workflow).toContain('classifyChapterAudioRetryability');
    expect(workflow).toContain('raiseChapterAudioNonRetryable');
    expect(workflow).toContain('raiseChapterAudioFailure');
    expect(workflow).toContain('rethrowAudioError');
    expect(workflow).not.toContain('if(type(');
    expect(workflow).not.toContain('get_type(');
    expect(workflow).toContain('chapterAudioAttemptError.message');
    expect(workflow).not.toContain('returnAudioError');
  });

  it('claims one run and reports the complete terminal lifecycle with the same runId', () => {
    expect(workflow).toContain('/internal/runs/" + runId + "/claim');
    expect(workflow.indexOf('- claimRun:')).toBeLessThan(
      workflow.indexOf('- generateChapterAudios:'),
    );
    expect(workflow).toContain('runId: ${runId}');
    expect(workflow).toContain('expectedChapters: ${len(chapters)}');
    expect(workflow).toContain('generatedChapters: ${finalizeResp.body.chaptersProcessed}');
    expect(workflow).toContain('validateAudiobookCompleteness');
  });
});
