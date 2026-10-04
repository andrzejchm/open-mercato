import type { AwilixContainer } from 'awilix'
import { getTranslationOverlayPlugin } from '@open-mercato/shared/lib/localization/overlay-plugin'
import { createLogger } from '@open-mercato/shared/lib/logger'

const logger = createLogger('entities').child({ component: 'definitions-localization' })

const CUSTOM_FIELD_DEF_ENTITY_TYPE = 'entities:custom_field_def'

export const DEFINITIONS_LOCALE_VARY_HEADER = 'Accept-Language, Cookie, X-Locale'

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

type OverlayRecord = Record<string, unknown>

export function isDefinitionsLocalizationAvailable(): boolean {
  const { overlay, resolveLocale } = getTranslationOverlayPlugin()
  return Boolean(overlay && resolveLocale)
}

function optionLabelKey(value: string): string {
  return `options.${value}.label`
}

function toOverlayRecord(definition: LocalizableDefinition): OverlayRecord {
  const record: OverlayRecord = {
    id: `${definition.entityId}:${definition.key}`,
    label: definition.label,
  }
  if (definition.description) record.description = definition.description
  for (const option of definition.options ?? []) {
    record[optionLabelKey(option.value)] = option.label
  }
  return record
}

function pickTranslation(passes: Array<OverlayRecord | undefined>, key: string): string | null {
  for (const pass of passes) {
    if (!pass) continue
    const translatedKeys = pass._translated
    if (!Array.isArray(translatedKeys) || !translatedKeys.includes(key)) continue
    const value = pass[key]
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return null
}

function localizeDefinition<T extends LocalizableDefinition>(
  definition: T,
  passes: Array<OverlayRecord | undefined>,
): T {
  const localized: T = { ...definition }
  localized.label = pickTranslation(passes, 'label') ?? definition.label
  if (definition.description) {
    localized.description = pickTranslation(passes, 'description') ?? definition.description
  }
  if (definition.options) {
    localized.options = definition.options.map((option) => ({
      ...option,
      label: pickTranslation(passes, optionLabelKey(option.value)) ?? option.label,
    }))
  }
  return localized
}

/**
 * Returns a copy of the definitions body with label, description and option
 * labels replaced by the request locale's translations. The input body is never
 * mutated: it may be the object held by the shared definitions cache.
 *
 * Translations are read through the translation overlay plugin, so this is a
 * no-op when the translations module is not registered. Rows are looked up in the
 * request organization first, then in the tenant-wide (organization-less) row.
 */
export async function localizeDefinitionsBody<T extends { items: LocalizableDefinition[] }>(
  body: T,
  context: LocalizationContext,
): Promise<T> {
  const { overlay, resolveLocale } = getTranslationOverlayPlugin()
  if (!overlay || !resolveLocale || body.items.length === 0) return body
  const locale = resolveLocale(context.request)
  if (!locale) return body

  const records = body.items.map(toOverlayRecord)
  const organizationScopes = context.organizationId ? [context.organizationId, null] : [null]
  let passes: OverlayRecord[][]
  try {
    passes = await Promise.all(
      organizationScopes.map((organizationId) =>
        overlay(records, {
          entityType: CUSTOM_FIELD_DEF_ENTITY_TYPE,
          locale,
          tenantId: context.tenantId,
          organizationId,
          container: context.container,
        }),
      ),
    )
  } catch (err) {
    logger.warn('Failed to localize custom field definitions', { locale, err })
    return body
  }

  return {
    ...body,
    items: body.items.map((definition, index) =>
      localizeDefinition(definition, passes.map((pass) => pass[index])),
    ),
  }
}
