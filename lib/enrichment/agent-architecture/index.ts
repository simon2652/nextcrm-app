import { AgentOrchestrator } from './orchestrator';
import type { AIGenerationContext } from '@/lib/llm/ai-router';

export { AgentOrchestrator } from './orchestrator';
export * from './core/types';

// Factory function for easy initialization
export function createAgentOrchestrator(
  firecrawlApiKey: string,
  aiContext: AIGenerationContext
) {
  return new AgentOrchestrator(firecrawlApiKey, aiContext);
}