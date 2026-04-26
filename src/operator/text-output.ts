export interface TextEmptyStateOption {
  key: string;
  aliases?: string[];
  label: string;
  description: string;
  command?: string;
  intent?: string;
}

export interface TextEmptyStateEvidence {
  label: string;
  value?: string;
  items?: string[];
}

export interface TextEmptyState {
  kind: string;
  summary: string;
  recommendedAction: string;
  evidence: TextEmptyStateEvidence[];
  options: TextEmptyStateOption[];
  replyPrompt?: string;
}

function formatOptionPrefix(option: TextEmptyStateOption): string {
  const aliases = option.aliases ?? [];
  const affirmativeAlias = aliases.find((alias) => alias.toLowerCase() === 'y');
  if (affirmativeAlias) {
    return `${affirmativeAlias.toUpperCase()} or ${option.key}.`;
  }
  return `${option.key}.`;
}

export function renderTextEmptyState(state: TextEmptyState): string {
  const lines: string[] = [];
  lines.push(state.summary);
  lines.push('');
  lines.push('Current state:');

  for (const evidence of state.evidence) {
    const items = evidence.items ?? [];
    if (items.length > 0) {
      lines.push(`- ${evidence.label}:`);
      for (const item of items) {
        lines.push(`  - ${item}`);
      }
      continue;
    }

    lines.push(`- ${evidence.label}: ${evidence.value ?? 'none'}`);
  }

  lines.push('');
  lines.push('Recommended next step:');
  for (const option of state.options) {
    lines.push(`${formatOptionPrefix(option)} ${option.label}`);
    lines.push(`   ${option.description}`);
  }

  if (state.replyPrompt) {
    lines.push('');
    lines.push(state.replyPrompt);
  }

  return lines.join('\n');
}
