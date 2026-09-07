export type ConfidentialityScope = 'project' | 'outside';

export type Label = {
  // Empty means public. Every scope must be authorized at the destination.
  confidentiality: readonly ConfidentialityScope[];
  integrity: 'trusted' | 'untrusted';
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

export const PROJECT_TRUSTED: Label = {
  confidentiality: ['project'],
  integrity: 'trusted',
};

export const OUTSIDE_TRUSTED: Label = {
  confidentiality: ['outside'],
  integrity: 'trusted',
};

export const OUTSIDE_UNTRUSTED: Label = {
  confidentiality: ['outside'],
  integrity: 'untrusted',
};

// Combining data keeps every confidentiality restriction and any untrusted
// influence. Copying outside text into the project cannot make it project-only.
export function combine(...labels: Label[]): Label {
  const scopes = new Set(labels.flatMap(label => label.confidentiality));
  const hasUntrustedInput = labels.some(label => label.integrity === 'untrusted');

  return {
    confidentiality: [...scopes].sort(),
    integrity: hasUntrustedInput ? 'untrusted' : 'trusted',
  };
}

// These are the permissions a user would need to grant for this particular
// transfer. The destination lists scopes it may receive. Granting an exception
// does not change the labels on the original data or later push permissions.
export function violations(source: Label, destination: Label): string[] {
  const reasons: string[] = [];

  const missingScopes = source.confidentiality.filter(scope => {
    return !destination.confidentiality.includes(scope);
  });
  if (missingScopes.length) {
    reasons.push(`release private data from scopes: ${missingScopes.join(', ')}`);
  }

  if (source.integrity === 'untrusted' && destination.integrity === 'trusted') {
    reasons.push('endorse work influenced by untrusted input');
  }

  return reasons;
}

export function labelText(label: Label): string {
  return `${confidentialityText(label)} / ${label.integrity}`;
}

export function confidentialityText(label: Label): string {
  return label.confidentiality.length
    ? `private[${label.confidentiality.join(', ')}]`
    : 'public';
}

export function readScopes(value: unknown): ConfidentialityScope[] {
  if (!Array.isArray(value) || !value.every(scope => scope === 'project' || scope === 'outside')) {
    throw new Error('Invalid confidentiality scopes.');
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
