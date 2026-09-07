export type ConfidentialityScope = 'project_private' | 'other_private';

export type Label = {
  // Empty means public. Combining data keeps every contributing scope.
  confidentiality: readonly ConfidentialityScope[];
  integrity: 'trusted' | 'untrusted';
};

export type DestinationPolicy = {
  allowedScopes: readonly ConfidentialityScope[];
  requiresTrustedInput: boolean;
};

export type FlowDecision = {
  source: Label;
  destination: DestinationPolicy;
  missingScopes: readonly ConfidentialityScope[];
  requiresEndorsement: boolean;
  requiresApproval: boolean;
};

export type LabeledValue = {
  value: string;
  label: Label;
};

export type TextOrReference = string | { ref: string };

export const PUBLIC_TRUSTED: Label = {
  confidentiality: [],
  integrity: 'trusted',
};

export const PUBLIC_UNTRUSTED: Label = {
  confidentiality: [],
  integrity: 'untrusted',
};

export const PROJECT_PRIVATE_TRUSTED: Label = {
  confidentiality: ['project_private'],
  integrity: 'trusted',
};

export const OTHER_PRIVATE_TRUSTED: Label = {
  confidentiality: ['other_private'],
  integrity: 'trusted',
};

export const OTHER_PRIVATE_UNTRUSTED: Label = {
  confidentiality: ['other_private'],
  integrity: 'untrusted',
};

// Combining data keeps every confidentiality restriction and any untrusted
// influence. Copying other private data into the project keeps both scopes.
export function combine(...labels: Label[]): Label {
  const scopes = new Set(labels.flatMap(label => label.confidentiality));
  const hasUntrustedInput = labels.some(label => label.integrity === 'untrusted');

  return {
    confidentiality: [...scopes].sort(),
    integrity: hasUntrustedInput ? 'untrusted' : 'trusted',
  };
}

// Report what needs authorization without changing the source label. The
// caller binds any approval to the exact operation it will execute.
export function checkFlow(source: Label, destination: DestinationPolicy): FlowDecision {
  const missingScopes = source.confidentiality.filter(scope => {
    return !destination.allowedScopes.includes(scope);
  });
  const requiresEndorsement = source.integrity === 'untrusted' && destination.requiresTrustedInput;

  return {
    source,
    destination,
    missingScopes,
    requiresEndorsement,
    requiresApproval: missingScopes.length > 0 || requiresEndorsement,
  };
}

export function destinationText(destination: DestinationPolicy): string {
  const scopes = destination.allowedScopes.join(', ') || 'public only';
  const integrity = destination.requiresTrustedInput ? 'trusted input' : 'any integrity';
  return `allows ${scopes}; ${integrity}`;
}

export function requireFlow(source: Label, destination: DestinationPolicy, target: string): void {
  if (checkFlow(source, destination).requiresApproval) {
    throw new Error(`Blocked by IFC: ${target} cannot receive ${labelText(source)}.`);
  }
}

export function labelText(label: Label): string {
  return `${confidentialityText(label)} / ${label.integrity}`;
}

export function confidentialityText(label: Label): string {
  return label.confidentiality.length
    ? `[${label.confidentiality.join(', ')}]`
    : 'public';
}

export function readScopes(value: unknown): ConfidentialityScope[] {
  if (!Array.isArray(value) || !value.every(scope => scope === 'project_private' || scope === 'other_private')) {
    throw new Error('Invalid confidentiality scopes. Expected project_private or other_private.');
  }

  return [...new Set<ConfidentialityScope>(value)].sort();
}

export function readLabel(value: unknown): Label {
  if (!value || typeof value !== 'object' || !('confidentiality' in value) || !('integrity' in value)) {
    throw new Error('Invalid IFC label.');
  }
  if (value.integrity !== 'trusted' && value.integrity !== 'untrusted') {
    throw new Error('Invalid IFC integrity.');
  }

  return { confidentiality: readScopes(value.confidentiality), integrity: value.integrity };
}
