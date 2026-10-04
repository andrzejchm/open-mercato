import type { AwilixContainer } from 'awilix'
import { getTranslationOverlayPlugin } from '@open-mercato/shared/lib/localization/overlay-plugin'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { createLogger } from '@open-mercato/shared/lib/logger'
import {
  CUSTOM_FIELD_DEF_TRANSLATION_ENTITY_TYPE,
  buildCustomFieldDefTranslationRecordId,
} from './definition-translation-identity'

const logger = createLogger('entities').child({ component: 'definitions-localization' })

export type LocalizableDefinition = {
  key: string
  entityId: string
  label: string
  description?: string
  options?: Array<{ value: string; label: string }>
}

type LocalizationContext = {
  request: Request
  container: AwilixContainer
  tenantId: string
  organizationId: string | null
}

export function isDefinitionsPayload(value: unknown): value is { items: LocalizableDefinition[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items)
}

function optionLabelField(value: string): string {
  return `options.${value}.label`
}

function toOverlayRecord(definition: LocalizableDefinition): Record<string, unknown> {
  const record: Record<string, unknown> = {
    id: buildCustomFieldDefTranslationRecordId(definition.entityId, definition.key),
    label: definition.label,
    description: definition.description ?? '',
  }
  for (const option of definition.options ?? []) {
    record[optionLabelField(option.value)] = option.label
  }
  return record
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function applyTranslations<T extends LocalizableDefinition>(
  definition: T,
  translated: Record<string, unknown>,
): T {
  return {
    ...definition,
    label: nonBlank(translated.label) ?? definition.label,
    description: nonBlank(translated.description) ?? definition.description,
    options: definition.options?.map((option) => ({
      ...option,
      label: nonBlank(translated[optionLabelField(option.value)]) ?? option.label,
    })),
  }
}

export async function localizeDefinitions<T extends LocalizableDefinition>(
  definitions: T[],
  context: LocalizationContext,
): Promise<T[]> {
  const { overlay, resolveLocale } = getTranslationOverlayPlugin()
  if (!overlay || !resolveLocale || definitions.length === 0) return definitions
  const locale = resolveLocale(context.request)
  if (!locale) return definitions
  try {
    const translated = await overlay(definitions.map(toOverlayRecord), {
      entityType: CUSTOM_FIELD_DEF_TRANSLATION_ENTITY_TYPE,
      locale,
      tenantId: context.tenantId,
      organizationId: context.organizationId,
      container: context.container,
    })
    return definitions.map((definition, index) => applyTranslations(definition, translated[index]))
  } catch (err) {
    logger.warn('Failed to localize custom field definitions', { locale, err })
    getTelemetryRuntime()?.reportError(err, {
      module: 'entities',
      code: 'entities.definitions_localization_failed',
    })
    return definitions
  }
}
