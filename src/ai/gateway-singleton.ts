/**
 * Lazy singleton for the base AI Gateway
 */
import { AIGateway } from '@/ai/gateway.js';

let _aiGatewaySingleton: AIGateway | null = null;

export function getAIGateway(): AIGateway {
  if (!_aiGatewaySingleton) {
    _aiGatewaySingleton = AIGateway.fromEnvironment();
  }
  return _aiGatewaySingleton;
}

// Test-only helper to reset the singleton between tests
export function resetAIGatewayForTests(): void {
  _aiGatewaySingleton = null;
}
