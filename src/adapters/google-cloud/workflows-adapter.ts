import { IWorkflowService } from '@/shared/interfaces.js';
import { WorkflowExecutionResult } from '@/shared/types.js';
import { ExecutionsClient } from '@google-cloud/workflows';
import { googleCloudConfig } from '@/config/environment.js';
import { logger } from '@/config/logger.js';

export class GoogleCloudWorkflowsAdapter implements IWorkflowService {
  private executionsClient: ExecutionsClient;

  constructor() {
    this.executionsClient = new ExecutionsClient();
  }

  async executeWorkflow(workflowId: string, parameters: Record<string, unknown>): Promise<string> {
    try {
      const config = googleCloudConfig.get();
      const workflowName = `projects/${config.projectId}/locations/${config.workflows.location}/workflows/${workflowId}`;

      logger.info('Executing Google Cloud Workflow', {
        workflowName,
        projectId: config.projectId,
        location: config.workflows.location,
        parametersKeys: Object.keys(parameters),
      });

      // Create an execution
      const [execution] = await this.executionsClient.createExecution({
        parent: workflowName,
        execution: {
          argument: JSON.stringify(parameters),
        },
      });

      const executionId = execution.name?.split('/').pop() || '';

      logger.info('Google Cloud Workflow execution started', {
        workflowId,
        executionId,
        executionName: execution.name,
      });

      return executionId;
    } catch (error) {
      logger.error('Failed to execute Google Cloud Workflow', {
        workflowId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getWorkflowExecution(executionId: string): Promise<WorkflowExecutionResult> {
    try {
      const config = googleCloudConfig.get();
      // Reconstruct the full execution name
      const executionName = `projects/${config.projectId}/locations/${config.workflows.location}/workflows/story-generation/executions/${executionId}`;

      logger.info('Getting Google Cloud Workflow execution status', {
        executionId,
        executionName,
      });

      const [execution] = await this.executionsClient.getExecution({
        name: executionName,
      });
      const result: WorkflowExecutionResult = {
        executionId,
        status: this.mapExecutionState(execution.state),
        startTime: execution.startTime
          ? new Date(Number(execution.startTime.seconds) * 1000)
          : new Date(),
        ...(execution.endTime && { endTime: new Date(Number(execution.endTime.seconds) * 1000) }),
        ...(execution.result && { result: JSON.parse(execution.result) }),
        ...(execution.error && { error: String(execution.error) }),
      };

      logger.info('Retrieved Google Cloud Workflow execution status', {
        executionId,
        status: result.status,
        hasResult: !!result.result,
        hasError: !!result.error,
      });

      return result;
    } catch (error) {
      logger.error('Failed to get Google Cloud Workflow execution status', {
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  private mapExecutionState(state?: unknown): 'pending' | 'running' | 'completed' | 'failed' {
    // Handle both string and enum values
    const stateStr = typeof state === 'string' ? state : String(state);
    switch (stateStr) {
      case 'QUEUED':
      case '5': // QUEUED enum value
        return 'pending';
      case 'ACTIVE':
      case '1': // ACTIVE enum value
        return 'running';
      case 'SUCCEEDED':
      case '2': // SUCCEEDED enum value
        return 'completed';
      case 'FAILED':
      case '3': // FAILED enum value
      case 'CANCELLED':
      case '4': // CANCELLED enum value
        return 'failed';
      default:
        return 'pending';
    }
  }
}
