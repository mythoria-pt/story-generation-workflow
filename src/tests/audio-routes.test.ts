import { describe, it, expect } from '@jest/globals';
import { readFile } from 'fs/promises';
import { join } from 'path';

describe('Audiobook Generation Workflow', () => {
  it('should have valid YAML workflow configuration', async () => {
    const workflowPath = join(process.cwd(), 'workflows', 'audiobook-generation.yaml');
    
    try {
      const workflowContent = await readFile(workflowPath, 'utf-8');
      
      // Basic validation that the workflow exists and has required content
      expect(workflowContent).toContain('main:');
      expect(workflowContent).toContain('storyId');
      expect(workflowContent).toContain('voice');
      expect(workflowContent).toContain('/internal/stories/');
      expect(workflowContent).toContain('/internal/audiobook/chapter');
      expect(workflowContent).toContain('/internal/audiobook/finalize');
      
    } catch (error) {
      throw new Error(`Audiobook workflow file not found or invalid: ${error}`);
    }
  });

  it('should validate workflow structure', async () => {
    const workflowPath = join(process.cwd(), 'workflows', 'audiobook-generation.yaml');
    const workflowContent = await readFile(workflowPath, 'utf-8');
    
    // Check for main workflow sections
    expect(workflowContent).toContain('validateStory:');
    expect(workflowContent).toContain('generateChapterAudios:');
    expect(workflowContent).toContain('finalizeAudiobook:');
    
    // Check for error handling
    expect(workflowContent).toContain('except:');
    expect(workflowContent).toContain('returnSuccess:');
    expect(workflowContent).toContain('returnAudioError:');
  });

  it('should have proper environment variables referenced', async () => {
    const workflowPath = join(process.cwd(), 'workflows', 'audiobook-generation.yaml');
    const workflowContent = await readFile(workflowPath, 'utf-8');
    
    // Check that the correct base URL is used
    expect(workflowContent).toContain('story-generation-workflow-803421888801.europe-west9.run.app');
    
    // Check for OIDC authentication
    expect(workflowContent).toContain('auth:   { type: OIDC }');
  });
});
