import type {
  AssetFieldDefinition,
  CollectionDefinition,
  CompiledDefinition,
  CompiledSchema,
  DefinitionKind,
  DocumentDefinition,
  EventDefinition,
  FieldDefinition,
  MdxConfigDefinition,
  SystemFieldDefinition,
} from './types';
import { normalizePath, stripExtension } from './utils';

export function getDefinition(
  compiled: CompiledSchema,
  name: string
): CompiledDefinition | undefined {
  return compiled.definitionsByName[name];
}

export function getCollection(
  compiled: CompiledSchema,
  name: string
): CompiledDefinition<CollectionDefinition> | undefined {
  const definition = getDefinition(compiled, name);
  return definition?.kind === 'collection'
    ? (definition as CompiledDefinition<CollectionDefinition>)
    : undefined;
}

export function getDocument(
  compiled: CompiledSchema,
  name: string
): CompiledDefinition<DocumentDefinition> | undefined {
  const definition = getDefinition(compiled, name);
  return definition?.kind === 'document'
    ? (definition as CompiledDefinition<DocumentDefinition>)
    : undefined;
}

export function getField(
  compiled: CompiledSchema,
  path: string
): FieldDefinition | undefined {
  return compiled.fieldsByPath[path]?.field;
}

export function resolveDefinitionForPath(
  compiled: CompiledSchema,
  path: string,
  mimeType?: string | null
): CompiledDefinition | undefined {
  const normalized = normalizePath(path);
  const base = normalized.split('/').pop() || normalized;
  const baseNoExt = stripExtension(base);

  if (
    mimeType &&
    mimeType.startsWith('image/') &&
    compiled.definitionsByPath[base]
  ) {
    const resolved = compiled.definitionsByPath[base];
    if (resolved.kind === 'image') {
      return resolved;
    }
  }

  return (
    compiled.definitionsByPath[normalized] ||
    compiled.definitionsByPath[base] ||
    compiled.definitionsByPath[baseNoExt]
  );
}

export function listReferences(compiled: CompiledSchema) {
  return compiled.referenceFields;
}

export function listConfigs(
  compiled: CompiledSchema
): Record<string, MdxConfigDefinition> {
  return compiled.configs;
}

export function listSystemFields(
  compiled: CompiledSchema,
  definitionName: string
): SystemFieldDefinition[] {
  return compiled.definitionsByName[definitionName]?.systemFields || [];
}

export function listAssetFields(
  compiled: CompiledSchema,
  definitionName?: string
): Array<{ definitionName: string; path: string; field: AssetFieldDefinition }> {
  return compiled.assetFields
    .filter((entry) => !definitionName || entry.definitionName === definitionName)
    .map((entry) => ({
      definitionName: entry.definitionName,
      path: entry.path,
      field: entry.field as AssetFieldDefinition,
    }));
}

export function listDefinitionsByKind(
  compiled: CompiledSchema,
  kind: DefinitionKind
) {
  return Object.values(compiled.definitionsByName).filter(
    (definition) => definition.kind === kind
  );
}

export function getEvent(
  compiled: CompiledSchema,
  name: string
): EventDefinition | undefined {
  return compiled.events[name];
}

export function listEvents(
  compiled: CompiledSchema
): Record<string, EventDefinition> {
  return compiled.events;
}
