import {
  combine,
  OTHER_PRIVATE_TRUSTED,
  OTHER_PRIVATE_UNTRUSTED,
  PROJECT_PRIVATE_TRUSTED,
  PUBLIC_TRUSTED,
  PUBLIC_UNTRUSTED,
  type ConfidentialityScope,
  type DestinationPolicy,
  type FlowDecision,
  type Label,
  type LabeledValue,
  type TextOrReference,
} from './ifc.ts';

export type DeliveryContext = {
  conversation: Label;
  store: (result: LabeledValue) => { ref: string };
  observe: (label: Label) => void;
};

type Deliver = (result: LabeledValue, context: DeliveryContext) => TextOrReference;

type ToolPolicy = {
  requests: DestinationPolicy;
  // Handlers join this source label with the request label. PUBLIC_TRUSTED
  // adds no restrictions; it never upgrades an untrusted request or result.
  replies: Label;
  deliver: Deliver;
};

export function expose(result: LabeledValue, context: DeliveryContext): string {
  context.observe(result.label);
  return result.value;
}

export function alwaysHide(result: LabeledValue, context: DeliveryContext): { ref: string } {
  const reference = context.store(result);

  // The reference does not expose the text's instructions, but we still keep
  // its confidentiality restrictions. The stored value keeps its full label.
  context.observe({ confidentiality: result.label.confidentiality, integrity: 'trusted' });
  return reference;
}

export function hideIfItWouldTaint(result: LabeledValue, context: DeliveryContext): TextOrReference {
  if (result.label.integrity === 'untrusted' && context.conversation.integrity === 'trusted') {
    return alwaysHide(result, context);
  }

  return expose(result, context);
}

export const initialConversation = PUBLIC_TRUSTED;
export const initialWorkspace = PROJECT_PRIVATE_TRUSTED;

// Unrecognized history, file attachments, and images may contain other private data.
export const unknownContext = OTHER_PRIVATE_UNTRUSTED;

export const outsideRead = {
  requiresApproval: true,
  untrusted: OTHER_PRIVATE_UNTRUSTED,
  trusted: OTHER_PRIVATE_TRUSTED,
};

export const fileRead = {
  deliver: hideIfItWouldTaint,
};

// Local work remains useful after reading private or untrusted data. The
// sandbox, rather than an integrity requirement, confines its effects.
export const localWork: DestinationPolicy = {
  allowedScopes: ['project_private', 'other_private'],
  requiresTrustedInput: false,
};

export const fileWrite = {
  requests: localWork,
  replies: PUBLIC_TRUSTED,
  deliver: expose,
} satisfies ToolPolicy;

// Shell output inherits the conversation and workspace labels. It is visible
// because the sandbox admits only the workspace and approved runtime inputs.
export const shell = {
  requests: localWork,
  replies: PUBLIC_TRUSTED,
  deliver: expose,
} satisfies ToolPolicy;

export const inspection = {
  deliver: expose,
};

// Sending any scope to the selected model provider is an explicit assumption.
export const model: DestinationPolicy = {
  allowedScopes: ['project_private', 'other_private'],
  requiresTrustedInput: false,
};

export const helper = {
  requests: model,
  replies: PUBLIC_TRUSTED,
  deliver: alwaysHide,
} satisfies ToolPolicy;

export const web = {
  requests: {
    allowedScopes: [],
    requiresTrustedInput: true,
  },
  // A public page adds no private scope. Joining this with the request label
  // preserves any private information the server could echo back.
  replies: PUBLIC_UNTRUSTED,
  deliver: hideIfItWouldTaint,
} satisfies ToolPolicy;

export const research = {
  requests: web.requests,
  // The user authorizes public use of the exact brief for this research job.
  // The researcher may follow untrusted web leads, but cannot read private data.
  browsing: {
    allowedScopes: [],
    requiresTrustedInput: false,
  } satisfies DestinationPolicy,
  replies: PUBLIC_UNTRUSTED,
  deliver: expose,
};

// Call only after the user reviews and endorses this exact text. This changes
// the artifact's integrity; it does not clear history or release private data.
export function endorse(result: LabeledValue): LabeledValue {
  return { ...result, label: { ...result.label, integrity: 'trusted' } };
}

export const gitPush = {
  requests(allowedScopes: readonly ConfidentialityScope[]): DestinationPolicy {
    return { allowedScopes, requiresTrustedInput: true };
  },
  // We trust the configured server, including hook messages. Joining with the
  // push label keeps prior taint and confidentiality restrictions.
  replies: PUBLIC_TRUSTED,
  deliver: expose,
};

// The UI, plan, and trace use the same decision. Wording never determines
// whether a request needs approval.
export function approvalReasons(decision: FlowDecision, endorsement: string): string[] {
  const reasons: string[] = [];
  if (decision.missingScopes.length) {
    reasons.push(`release private data from scopes: ${decision.missingScopes.join(', ')}`);
  }
  if (decision.requiresEndorsement) {
    reasons.push(endorsement);
  }
  return reasons;
}

export function toolFailureLabel(conversation: Label, workspace: Label, references: Label[]): Label {
  // A failed tool can reveal its inputs or workspace state too. Keep the
  // conservative whole-workspace influence used by the tool error handler.
  return combine(conversation, workspace, ...references);
}
