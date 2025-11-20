export interface SelfPrintRecipient {
  email: string;
  name?: string;
  locale?: string;
}

export interface SelfPrintDelivery {
  recipients: SelfPrintRecipient[];
  ccEmails?: string[];
  locale?: string;
  metadata?: Record<string, unknown>;
  requestedBy?: {
    authorId?: string;
    email?: string;
    name?: string | null;
  };
}

export interface SelfPrintWorkflowPayload {
  storyId: string;
  runId: string;
  generateCMYK?: boolean;
  delivery?: SelfPrintDelivery;
  initiatedBy?: 'selfService' | 'adminPortal' | string;
}
