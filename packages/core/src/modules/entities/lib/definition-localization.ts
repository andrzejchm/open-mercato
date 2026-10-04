import type { AwilixContainer } from 'awilix'
import { getTranslationOverlayPlugin } from '@open-mercato/shared/lib/localization/overlay-plugin'
import { getTelemetryRuntime } from '@open-mercato/shared/lib/telemetry/runtime'
import { createLogger } from '@open-mercato/shared/lib/logger'
import type { CustomFieldOptionDto } from '@open-mercato/shared/modules/entities/options'
import {
  CUSTOM_FIELD_DEF_DESCRIPTION_TRANSLATION_FIELD,
  CUSTOM_FIELD_DEF_LABEL_TRANSLATION_FIELD,
  CUSTOM_FIELD_DEF_TRANSLATION_ENTITY_TYPE,
  buildCustomFieldDefTranslationRecordId,
  buildCustomFieldOptionLabelTranslationField,
} from './definition-translation-identity'

const logger = createLogger('entities').child({ component: 'definitions-localization' })

export type DefinitionLocalizationSource = {
  definitionId: string | null
  entityId: string
  key: string
  organizationScoped: boolean
}

export type LocalizableDefinitionItem = {
  label?: string
  description?: string
  options?: CustomFieldOptionDto[]
}

type TranslationIdentity = 'legacy-definition-id' | 'canonical'

type TranslationPass = {
  organizationId: string | null
  identity: TranslationIdentity
  tenantLevel: boolean
}

type TranslatedFields = Record<string, string | undefined>

export type DefinitionLocalizationScope = {
  tenantId: string
  organizationId: string | null
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function collectBaseFields(item: LocalizableDefinitionItem): TranslatedFields {
  const fields: TranslatedFields = {
    [CUSTOM_FIELD_DEF_LABEL_TRANSLATION_FIELD]: item.label,
    [CUSTOM_FIELD_DEF_DESCRIPTION_TRANSLATION_FIELD]: item.description,
  }
  for (const option of item.options ?? []) {
    fields[buildCustomFieldOptionLabelTranslationField(option.value)] = option.label
  }
  return fields
}

/**
 * Passes run from the least to the most specific, so a later pass overrides an earlier one
 * per field: tenant-level translations first, organization-level translations last, and for
 * each scope the legacy definition-id identity before the canonical `entityId:key` identity.
 */
function buildPasses(organizationId: string | null): TranslationPass[] {
  const identities: TranslationIdentity[] = ['legacy-definition-id', 'canonical']
  const passes: TranslationPass[] = identities.map((identity) => ({
    organizationId: null,
    identity,
    tenantLevel: true,
  }))
  if (organizationId) {
    for (const identity of identities) {
      passes.push({ organizationId, identity, tenantLevel: false })
    }
  }
  return passes
}

function resolvePassRecordId(
  pass: TranslationPass,
  source: DefinitionLocalizationSource,
): string | null {
  if (pass.identity === 'legacy-definition-id') return source.definitionId
  return buildCustomFieldDefTranslationRecordId(source.entityId, source.key)
}

/**
 * Overlays `entities:custom_field_def` translations for `locale` onto already-resolved
 * definition items. The base items are never mutated.
 *
 * - Winner semantics: `sources[i]` describes the definition that won inheritance for
 *   `items[i]`. A definition owned by an organization never receives tenant-level
 *   translations, because those belong to the tenant-level definition it overrides.
 * - Fallback: any field without a non-empty translation keeps the base value.
 * - Scope: rows are read through the translation overlay plugin with the request's own
 *   tenant and organization, so no other tenant or organization is ever consulted.
 */
export async function applyDefinitionTranslations<T extends LocalizableDefinitionItem>(
  items: T[],
  sources: DefinitionLocalizationSource[],
  options: {
    locale: string
    scope: DefinitionLocalizationScope
    container: AwilixContainer
    overlay: NonNullable<ReturnType<typeof getTranslationOverlayPlugin>['overlay']>
  },
): Promise<T[]> {
  if (!items.length || items.length !== sources.length) return items

  const working = items.map((item) => collectBaseFields(item))

  for (const pass of buildPasses(options.scope.organizationId)) {
    const entries: Array<{ index: number; record: Record<string, unknown> }> = []
    items.forEach((_, index) => {
      const source = sources[index]
      if (pass.tenantLevel && source.organizationScoped) return
      const recordId = resolvePassRecordId(pass, source)
      if (!recordId) return
      entries.push({ index, record: { ...working[index], id: recordId } })
    })
    if (!entries.length) continue

    const overlaid = await options.overlay(
      entries.map((entry) => entry.record),
      {
        entityType: CUSTOM_FIELD_DEF_TRANSLATION_ENTITY_TYPE,
        locale: options.locale,
        tenantId: options.scope.tenantId,
        organizationId: pass.organizationId,
        container: options.container,
      },
    )

    overlaid.forEach((record, position) => {
      const target = working[entries[position].index]
      for (const field of Object.keys(target)) {
        const translated = record[field]
        if (hasText(translated)) target[field] = translated
      }
    })
  }

  return items.map((item, index) => {
    const fields = working[index]
    const patch: LocalizableDefinitionItem = {}
    const label = fields[CUSTOM_FIELD_DEF_LABEL_TRANSLATION_FIELD]
    if (hasText(label)) patch.label = label
    const description = fields[CUSTOM_FIELD_DEF_DESCRIPTION_TRANSLATION_FIELD]
    if (hasText(description)) patch.description = description
    if (item.options?.length) {
      patch.options = item.options.map((option) => {
        const optionLabel = fields[buildCustomFieldOptionLabelTranslationField(option.value)]
        return hasText(optionLabel) ? { ...option, label: optionLabel } : { ...option }
      })
    }
    return { ...item, ...patch }
  })
}

/**
 * Request-level entry point. Resolves the active locale and the registered overlay plugin;
 * when either is unavailable (translations module disabled, no locale on the request) the
 * base items are returned untouched. A translation failure never fails the definitions
 * read: it is reported and the base items are served.
 */
export async function localizeDefinitionItemsForRequest<T extends LocalizableDefinitionItem>(
  items: T[],
  sources: DefinitionLocalizationSource[],
  options: {
    request: Request
    scope: DefinitionLocalizationScope
    container: AwilixContainer
  },
): Promise<T[]> {
  if (!items.length) return items
  const { overlay, resolveLocale } = getTranslationOverlayPlugin()
  if (!overlay || !resolveLocale) return items
  const locale = resolveLocale(options.request)
  if (!locale) return items
  try {
    return await applyDefinitionTranslations(items, sources, {
      locale,
      scope: options.scope,
      container: options.container,
      overlay,
    })
  } catch (error) {
    logger.warn('Failed to localize custom field definitions', { locale, err: error })
    getTelemetryRuntime()?.reportError(error, {
      module: 'entities',
      code: 'entities.definitions_localization_failed',
    })
    return items
  }
}
