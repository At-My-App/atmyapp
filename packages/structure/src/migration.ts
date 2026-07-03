import type {
  CollectionDefinition,
  Definition,
  FieldDefinition,
  MigrationAction,
  MigrationChange,
  MigrationCompatibilityClass,
  MigrationPlan,
  MigrationPrompt,
  SchemaDocument,
  SystemFieldDefinition,
} from './types';
import { compileSchema } from './compiler';
import { stableKey } from './utils';

function fieldIdentity(field: FieldDefinition): string {
  switch (field.kind) {
    case 'scalar':
      return `scalar:${field.scalar}`;
    case 'enum':
      return `enum:${field.values.map((value) => typeof value).join(',')}`;
    case 'object':
      return `object:${Object.keys(field.fields).sort().join(',')}`;
    case 'array':
      return `array:${fieldIdentity(field.items)}`;
    case 'union':
      return `union:${field.variants.map(fieldIdentity).sort().join('|')}`;
    case 'asset':
      return `asset:${field.assetKind}:${field.multiple ? 'many' : 'one'}`;
    case 'reference':
      return `reference:${field.target}:${field.multiple ? 'many' : 'one'}`;
    case 'mdx':
      return `mdx:${field.config}`;
    case 'slug':
      return 'slug';
  }
}

export function classifyTypeChange(
  fromField: FieldDefinition,
  toField: FieldDefinition
): MigrationCompatibilityClass {
  const fromIdentity = fieldIdentity(fromField);
  const toIdentity = fieldIdentity(toField);
  if (fromIdentity === toIdentity) {
    return 'compatible';
  }

  if (toField.kind === 'union' && toField.variants.some((variant) => fieldIdentity(variant) === fromIdentity)) {
    return 'safe_auto_convert';
  }

  const fromScalar = fromField.kind === 'scalar' ? fromField.scalar : null;
  const toScalar = toField.kind === 'scalar' ? toField.scalar : null;

  if (
    (fromScalar === 'number' && toScalar === 'string') ||
    (fromScalar === 'boolean' && toScalar === 'string') ||
    (fromScalar === 'date' && toScalar === 'string') ||
    (fromScalar === 'datetime' && toScalar === 'string') ||
    (fromScalar === 'timestamp' && toScalar === 'string') ||
    (fromScalar === 'string' &&
      (toScalar === 'number' ||
        toScalar === 'date' ||
        toScalar === 'datetime' ||
        toScalar === 'timestamp'))
  ) {
    return 'confirmable_convert';
  }

  return 'incompatible';
}

function compareSystemFields(
  definitionName: string,
  currentFields: SystemFieldDefinition[],
  nextFields: SystemFieldDefinition[],
  changes: MigrationChange[]
) {
  const currentByName = Object.fromEntries(currentFields.map((field) => [field.name, field]));
  const nextByName = Object.fromEntries(nextFields.map((field) => [field.name, field]));
  const names = new Set([...Object.keys(currentByName), ...Object.keys(nextByName)]);

  for (const name of names) {
    if (stableKey(currentByName[name]) === stableKey(nextByName[name])) {
      continue;
    }
    changes.push({
      kind: 'system_field_changed',
      definitionName,
      fieldPath: name,
      compatibility:
        name === 'slug' && nextByName[name]?.enabled
          ? 'confirmable_convert'
          : 'compatible',
    });
  }
}

function compareIndexes(
  definitionName: string,
  current: CollectionDefinition,
  next: CollectionDefinition,
  changes: MigrationChange[]
) {
  const currentIndexes = new Set((current.indexes || []).map((entry) => stableKey(entry)));
  const nextIndexes = new Set((next.indexes || []).map((entry) => stableKey(entry)));

  for (const index of nextIndexes) {
    if (!currentIndexes.has(index)) {
      changes.push({
        kind: 'index_added',
        definitionName,
        compatibility: 'compatible',
      });
    }
  }

  for (const index of currentIndexes) {
    if (!nextIndexes.has(index)) {
      changes.push({
        kind: 'index_removed',
        definitionName,
        compatibility: 'compatible',
      });
    }
  }
}

function compareFields(
  definitionName: string,
  currentFields: Record<string, FieldDefinition>,
  nextFields: Record<string, FieldDefinition>,
  changes: MigrationChange[],
  pathPrefix: string = definitionName
) {
  const names = new Set([...Object.keys(currentFields), ...Object.keys(nextFields)]);
  for (const name of names) {
    const currentField = currentFields[name];
    const nextField = nextFields[name];
    const fieldPath = `${pathPrefix}.${name}`;

    if (!currentField && nextField) {
      changes.push({
        kind: 'field_added',
        definitionName,
        fieldPath,
        compatibility: 'compatible',
      });
      continue;
    }

    if (currentField && !nextField) {
      changes.push({
        kind: 'field_removed',
        definitionName,
        fieldPath,
        compatibility: 'incompatible',
      });
      continue;
    }

    if (!currentField || !nextField) {
      continue;
    }

    const compatibility = classifyTypeChange(currentField, nextField);
    if (compatibility !== 'compatible') {
      changes.push({
        kind: 'field_type_changed',
        definitionName,
        fieldPath,
        fromType: fieldIdentity(currentField),
        toType: fieldIdentity(nextField),
        compatibility,
      });
    }

    if (Boolean(currentField.unique) !== Boolean(nextField.unique)) {
      changes.push({
        kind: 'field_unique_changed',
        definitionName,
        fieldPath,
        compatibility: nextField.unique ? 'confirmable_convert' : 'compatible',
      });
    }

    if (Boolean(currentField.localize) !== Boolean(nextField.localize)) {
      changes.push({
        kind: 'field_localize_changed',
        definitionName,
        fieldPath,
        compatibility: 'incompatible',
      });
    }

    if (
      currentField.kind === 'array' &&
      nextField.kind === 'array' &&
      currentField.identityField !== nextField.identityField
    ) {
      changes.push({
        kind: 'array_identity_field_changed',
        definitionName,
        fieldPath,
        compatibility: 'incompatible',
      });
    }

    if (currentField.kind === 'object' && nextField.kind === 'object') {
      compareFields(
        definitionName,
        currentField.fields,
        nextField.fields,
        changes,
        fieldPath
      );
    }

    if (
      currentField.kind === 'array' &&
      nextField.kind === 'array' &&
      currentField.items.kind === 'object' &&
      nextField.items.kind === 'object'
    ) {
      compareFields(
        definitionName,
        currentField.items.fields,
        nextField.items.fields,
        changes,
        `${fieldPath}[]`
      );
    }
  }
}

export function diffSchemas(
  currentInput: SchemaDocument | string,
  nextInput: SchemaDocument | string
): MigrationChange[] {
  const current = compileSchema(currentInput).document;
  const next = compileSchema(nextInput).document;
  const currentCompiled = compileSchema(current);
  const nextCompiled = compileSchema(next);
  const changes: MigrationChange[] = [];

  if (
    Boolean(current.localization?.enabled) !==
    Boolean(next.localization?.enabled)
  ) {
    changes.push({
      kind: 'localization_changed',
      definitionName: '*',
      compatibility: 'incompatible',
    });
  }

  const names = new Set([
    ...Object.keys(current.definitions),
    ...Object.keys(next.definitions),
  ]);

  for (const name of names) {
    const currentDefinition = current.definitions[name];
    const nextDefinition = next.definitions[name];

    if (!currentDefinition && nextDefinition) {
      changes.push({
        kind: 'definition_added',
        definitionName: name,
        compatibility: 'compatible',
      });
      continue;
    }

    if (currentDefinition && !nextDefinition) {
      changes.push({
        kind: 'definition_removed',
        definitionName: name,
        compatibility: 'incompatible',
      });
      continue;
    }

    if (!currentDefinition || !nextDefinition) {
      continue;
    }

    if (currentDefinition.kind !== nextDefinition.kind) {
      changes.push({
        kind: 'definition_kind_changed',
        definitionName: name,
        compatibility: 'incompatible',
      });
      continue;
    }

    if (Boolean(currentDefinition.localize) !== Boolean(nextDefinition.localize)) {
      changes.push({
        kind: 'definition_localize_changed',
        definitionName: name,
        compatibility: 'incompatible',
      });
    }

    compareSystemFields(
      name,
      currentCompiled.definitionsByName[name]?.systemFields || [],
      nextCompiled.definitionsByName[name]?.systemFields || [],
      changes
    );

    if (
      (currentDefinition.kind === 'collection' ||
        currentDefinition.kind === 'document' ||
        currentDefinition.kind === 'system_config') &&
      (nextDefinition.kind === 'collection' ||
        nextDefinition.kind === 'document' ||
        nextDefinition.kind === 'system_config')
    ) {
      compareFields(name, currentDefinition.fields, nextDefinition.fields, changes);
    }

    if (currentDefinition.kind === 'collection' && nextDefinition.kind === 'collection') {
      compareIndexes(name, currentDefinition, nextDefinition, changes);
    }
  }

  return changes;
}

function actionForChange(change: MigrationChange): MigrationAction[] {
  switch (change.kind) {
    case 'definition_removed':
      return [
        {
          type: 'drop_definition',
          definitionName: change.definitionName,
          message: `Definition "${change.definitionName}" will be removed.`,
          compatibility: change.compatibility,
        },
      ];
    case 'field_removed':
      return [
        {
          type: 'drop_field',
          definitionName: change.definitionName,
          fieldPath: change.fieldPath,
          message: `Field "${change.fieldPath}" will be removed.`,
          compatibility: change.compatibility,
        },
      ];
    case 'field_type_changed':
      if (change.compatibility === 'safe_auto_convert') {
        return [
          {
            type: 'auto_convert',
            definitionName: change.definitionName,
            fieldPath: change.fieldPath,
            message: `Field "${change.fieldPath}" will be converted automatically from ${change.fromType} to ${change.toType}.`,
            compatibility: change.compatibility,
          },
        ];
      }
      if (change.compatibility === 'confirmable_convert') {
        return [
          {
            type: 'confirm_convert',
            definitionName: change.definitionName,
            fieldPath: change.fieldPath,
            message: `Field "${change.fieldPath}" can be converted from ${change.fromType} to ${change.toType} with confirmation.`,
            compatibility: change.compatibility,
          },
        ];
      }
      return [
        {
          type: 'require_union',
          definitionName: change.definitionName,
          fieldPath: change.fieldPath,
          message: `Field "${change.fieldPath}" changes from ${change.fromType} to ${change.toType} and requires a union or manual migration.`,
          compatibility: change.compatibility,
        },
      ];
    case 'field_unique_changed':
      return change.compatibility === 'confirmable_convert'
        ? [
            {
              type: 'create_unique_index',
              definitionName: change.definitionName,
              fieldPath: change.fieldPath,
              message: `Field "${change.fieldPath}" is becoming unique and needs a uniqueness check/backfill.`,
              compatibility: change.compatibility,
            },
          ]
        : [];
    case 'system_field_changed':
      if (change.fieldPath === 'slug') {
        return [
          {
            type: 'backfill_generated_field',
            definitionName: change.definitionName,
            fieldPath: change.fieldPath,
            message: `System field "${change.definitionName}.slug" must be backfilled before activation.`,
            compatibility: change.compatibility,
          },
          {
            type: 'create_unique_index',
            definitionName: change.definitionName,
            fieldPath: change.fieldPath,
            message: `System field "${change.definitionName}.slug" requires a unique index.`,
            compatibility: change.compatibility,
          },
        ];
      }
      return [];
    case 'localization_changed':
    case 'definition_localize_changed':
    case 'field_localize_changed':
    case 'array_identity_field_changed':
      return [
        {
          type: 'require_clear',
          definitionName: change.definitionName,
          fieldPath: change.fieldPath,
          message: `Localized storage metadata changed for "${change.fieldPath || change.definitionName}" and scoped data must be cleared explicitly.`,
          compatibility: change.compatibility,
        },
      ];
    default:
      return [];
  }
}

export function renderMigrationPrompts(plan: MigrationPlan): MigrationPrompt[] {
  return plan.actions
    .filter((action) => action.type !== 'auto_convert')
    .map((action) => ({
      title: action.fieldPath
        ? `Review ${action.fieldPath}`
        : `Review ${action.definitionName}`,
      message: action.message,
      actionType: action.type,
      definitionName: action.definitionName,
      fieldPath: action.fieldPath,
    }));
}

export function planMigration(
  currentInput: SchemaDocument | string,
  nextInput: SchemaDocument | string
): MigrationPlan {
  const changes = diffSchemas(currentInput, nextInput);
  const actions = changes.flatMap(actionForChange);
  const prompts = renderMigrationPrompts({
    changes,
    actions,
    prompts: [],
    blocking: false,
  });
  const blocking = actions.some((action) =>
    ['require_union', 'require_clear', 'require_manual_migration', 'drop_definition', 'drop_field'].includes(action.type)
  );

  return {
    changes,
    actions,
    prompts,
    blocking,
  };
}
