import crypto from 'node:crypto';

import {
  REVIEW_DATA_LIMITS,
  decodeBoundedUtf8File,
  normalizeReviewDataField,
} from './review-data.ts';
import type { FixVerificationCommandEvidence } from './state.ts';

export interface FixVerificationInput {
  source: string;
  commands: FixVerificationCommandEvidence[];
}

export function readFixVerificationFile(filePath: string): FixVerificationInput {
  const text = decodeBoundedUtf8File(filePath, '--verification-file', REVIEW_DATA_LIMITS.verificationFileBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`--verification-file must contain JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--verification-file must contain an object with source and commands.');
  }
  const raw = parsed as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !['source', 'commands'].includes(key));
  if (unknown.length > 0) throw new Error(`--verification-file contains unknown field(s): ${unknown.join(', ')}.`);
  if (typeof raw.source !== 'string') throw new Error('--verification-file source must be a string.');
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) {
    throw new Error('--verification-file commands must be a non-empty array.');
  }
  if (raw.commands.length > REVIEW_DATA_LIMITS.verificationCommandCount) {
    throw new Error(`--verification-file exceeds the ${REVIEW_DATA_LIMITS.verificationCommandCount}-command limit.`);
  }
  return {
    source: normalizeReviewDataField(raw.source, {
      field: 'verification source',
      maxBytes: REVIEW_DATA_LIMITS.provenanceFieldBytes,
      redact: true,
    }),
    commands: raw.commands.map((value, index): FixVerificationCommandEvidence => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`verification command ${index + 1} must be an object.`);
      }
      const command = value as Record<string, unknown>;
      const commandUnknown = Object.keys(command).filter((key) => !['command', 'exitCode', 'output'].includes(key));
      if (commandUnknown.length > 0) throw new Error(`verification command ${index + 1} contains unknown field(s): ${commandUnknown.join(', ')}.`);
      if (typeof command.command !== 'string') throw new Error(`verification command ${index + 1} command must be a string.`);
      if (typeof command.exitCode !== 'number' || !Number.isSafeInteger(command.exitCode)) {
        throw new Error(`verification command ${index + 1} exitCode must be a safe integer.`);
      }
      if (typeof command.output !== 'string') throw new Error(`verification command ${index + 1} output must be a string.`);
      const normalizedOutput = normalizeReviewDataField(command.output, {
        field: `verification command ${index + 1} output`,
        maxBytes: REVIEW_DATA_LIMITS.verificationOutputBytes,
        allowEmpty: true,
        redact: true,
      });
      return {
        source: 'host-attestation',
        command: normalizeReviewDataField(command.command, {
          field: `verification command ${index + 1}`,
          maxBytes: REVIEW_DATA_LIMITS.verificationCommandBytes,
          redact: true,
        }),
        exitCode: command.exitCode,
        outputDigest: crypto.createHash('sha256').update(normalizedOutput).digest('hex'),
      };
    }),
  };
}
