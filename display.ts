import type { Theme } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';

import { confidentialityText, type Label } from './ifc.ts';

export type ToolTrace = {
  before: Label;
  after: Label;
  work: Label;
  trace: string[];
};

// File contents and server replies can contain terminal control sequences.
// Show those bytes as text instead of letting them control the terminal.
export function visible(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, character => {
    const code = character.charCodeAt(0).toString(16).padStart(2, '0');
    return `\\x${code}`;
  });
}

function renderLabel(title: string, label: Label, theme: Theme): string {
  const confidentialityColor = label.confidentiality.length ? 'accent' : 'success';
  const integrityColor = label.integrity === 'untrusted' ? 'warning' : 'success';

  const confidentiality = theme.fg(confidentialityColor, `confidentiality=${confidentialityText(label)}  `);
  const integrity = theme.fg(integrityColor, `integrity=${label.integrity}`);

  return theme.fg('dim', `│ [ifc] ${title}  `)
    + theme.fg('dim', confidentiality)
    + theme.fg('dim', integrity);
}

export function renderToolCall(name: string, input: object, theme: Theme): Text {
  const inputText = visible(JSON.stringify(input)).slice(0, 1500);
  const heading = theme.fg('dim', `┌─ ${name}\n│ input: ${inputText}`);

  return new Text(heading, 0, 0);
}

export function renderToolResult(
  text: string,
  trace: ToolTrace | undefined,
  expanded: boolean,
  debug: boolean,
  theme: Theme,
): Text {
  const lines: string[] = [];
  const showTrace = debug && trace?.before && trace?.after && Array.isArray(trace?.trace);

  if (showTrace) {
    lines.push(renderLabel('conversation before', trace.before, theme));

    for (const event of trace.trace) {
      lines.push(theme.fg('dim', `│ [ifc] ${visible(event)}`));
    }
  }

  const output = expanded ? text : text.slice(0, 1600);
  for (const line of visible(output).split('\n')) {
    lines.push(`${theme.fg('dim', '│ ')}${line}`);
  }

  if (showTrace) {
    lines.push(renderLabel('conversation after', trace.after, theme));
    lines.push(renderLabel('workspace', trace.work, theme));
  }

  lines.push(theme.fg('dim', '└─'));
  return new Text(lines.join('\n'), 0, 0);
}
