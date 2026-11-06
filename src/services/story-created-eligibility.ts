/** Only explicit story generation or legacy runs with actual generation steps qualify. */
export function isStoryCreatedEligible(
  metadata: unknown,
  steps: Array<{ stepName: string; status: string }>,
): boolean {
  if (metadata !== null && metadata !== undefined) {
    if (typeof metadata !== 'object') return false;
    const root = metadata as Record<string, unknown>;
    const delivery = root.delivery as Record<string, unknown> | undefined;
    const deliveryMetadata = delivery?.metadata as Record<string, unknown> | undefined;
    const code = root.serviceCode ?? deliveryMetadata?.serviceCode;
    return code === 'storyGeneration';
  }
  return steps.some(
    (step) =>
      step.status === 'completed' &&
      (step.stepName === 'generate_outline' || /^write_chapter_\d+$/.test(step.stepName)),
  );
}
