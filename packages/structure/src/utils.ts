import type { FieldDefinition } from './types';

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export function stripExtension(value: string): string {
  const normalized = normalizePath(value);
  const idx = normalized.lastIndexOf('.');
  if (idx === -1) {
    return normalized;
  }
  return normalized.slice(0, idx);
}

export function ensureDocumentPath(path: string): string {
  const normalized = normalizePath(path);
  if (
    normalized.endsWith('.json') ||
    normalized.endsWith('.jsonx') ||
    normalized.endsWith('.md')
  ) {
    return normalized;
  }
  return `${normalized}.json`;
}

export function stableKey(value: unknown): string {
  return JSON.stringify(value, Object.keys((value as Record<string, unknown>) || {}).sort());
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isFieldOptional(field: FieldDefinition): boolean {
  if (typeof field.optional === 'boolean') {
    return field.optional;
  }
  if (typeof field.required === 'boolean') {
    return !field.required;
  }
  return false;
}
