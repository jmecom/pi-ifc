export type Label = {
  confidentiality: 'public' | 'private';
  integrity: 'trusted' | 'untrusted';
};

export type LabeledValue = {
  value: string;
  label: Label;
};

export type TextOrReference = string | { ref: string };

export const PUBLIC_TRUSTED: Label = {
  confidentiality: 'public',
  integrity: 'trusted',
};

export const PRIVATE_TRUSTED: Label = {
  confidentiality: 'private',
  integrity: 'trusted',
};

export const PRIVATE_UNTRUSTED: Label = {
  confidentiality: 'private',
  integrity: 'untrusted',
};

// Once private or untrusted data has influenced something, combining it with
// other data cannot make it public or trusted again.
export function combine(...labels: Label[]): Label {
  const hasPrivateData = labels.some(label => label.confidentiality === 'private');
  const hasUntrustedInput = labels.some(label => label.integrity === 'untrusted');

  return {
    confidentiality: hasPrivateData ? 'private' : 'public',
    integrity: hasUntrustedInput ? 'untrusted' : 'trusted',
  };
}

// These are the permissions a user would need to grant for this particular
// transfer. Granting them does not change the labels on the original data.
export function violations(source: Label, destination: Label): string[] {
  const reasons: string[] = [];

  if (source.confidentiality === 'private' && destination.confidentiality === 'public') {
    reasons.push('release private data');
  }

  if (source.integrity === 'untrusted' && destination.integrity === 'trusted') {
    reasons.push('endorse work influenced by untrusted input');
  }

  return reasons;
}

export function labelText(label: Label): string {
  return `${label.confidentiality} / ${label.integrity}`;
}
