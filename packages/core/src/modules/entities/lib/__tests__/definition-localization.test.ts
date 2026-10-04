import type { AwilixContainer } from 'awilix'
import { applyLocalizedContent } from '@open-mercato/shared/lib/localization/resolver'
import {
  registerTranslationOverlayPlugin,
  type TranslationOverlayFn,
} from '@open-mercato/shared/lib/localization/overlay-plugin'
import {
  registerTelemetryRuntime,
  resetTelemetryRuntime,
  type TelemetryRuntime,
} from '@open-mercato/shared/lib/telemetry/runtime'
import {
  applyDefinitionTranslations,
  localizeDefinitionItemsForRequest,
  type DefinitionLocalizationSource,
  type LocalizableDefinitionItem,
} from '../definition-localization'
import {
  CUSTOM_FIELD_DEF_TRANSLATION_ENTITY_TYPE,
  buildCustomFieldDefTranslationRecordId,
} from '../definition-translation-identity'

type TranslationRow = {
  entityType: string
  entityId: string
  tenantId: string | null
  organizationId: string | null
  translations: Record<string, Record<string, unknown>>
}

const TENANT = 'tenant-1'
const ORG = 'org-1'
const ENTITY = 'customers:customer_person_profile'
const container = {} as AwilixContainer

function createOverlay(rows: TranslationRow[]): jest.MockedFunction<TranslationOverlayFn> {
  return jest.fn(async (items, options) => {
    return items.map((item) => {
      const row = rows.find(
        (candidate) =>
          candidate.entityType === options.entityType &&
          candidate.entityId === String(item.id) &&
          candidate.tenantId === (options.tenantId ?? null) &&
          candidate.organizationId === (options.organizationId ?? null),
      )
      return applyLocalizedContent(item, row?.translations ?? null, options.locale)
    })
  })
}

function row(
  entityId: string,
  translations: TranslationRow['translations'],
  scope: { tenantId?: string | null; organizationId?: string | null } = {},
): TranslationRow {
  return {
    entityType: CUSTOM_FIELD_DEF_TRANSLATION_ENTITY_TYPE,
    entityId,
    tenantId: scope.tenantId === undefined ? TENANT : scope.tenantId,
    organizationId: scope.organizationId === undefined ? null : scope.organizationId,
    translations,
  }
}

function source(overrides: Partial<DefinitionLocalizationSource> = {}): DefinitionLocalizationSource {
  return {
    definitionId: 'def-1',
    entityId: ENTITY,
    key: 'priority',
    organizationScoped: false,
    ...overrides,
  }
}

const baseItem = (): LocalizableDefinitionItem & Record<string, unknown> => ({
  key: 'priority',
  kind: 'select',
  label: 'Priority',
  description: 'How urgent it is',
  options: [
    { value: 'high', label: 'High' },
    { value: 'low', label: 'Low' },
  ],
})

const canonicalId = buildCustomFieldDefTranslationRecordId(ENTITY, 'priority')

async function localize(
  rows: TranslationRow[],
  locale: string,
  options: { organizationId?: string | null; sources?: DefinitionLocalizationSource[]; items?: Array<LocalizableDefinitionItem & Record<string, unknown>> } = {},
) {
  const overlay = createOverlay(rows)
  const items = options.items ?? [baseItem()]
  const result = await applyDefinitionTranslations(items, options.sources ?? [source()], {
    locale,
    scope: {
      tenantId: TENANT,
      organizationId: options.organizationId === undefined ? ORG : options.organizationId,
    },
    container,
    overlay,
  })
  return { result, overlay, items }
}

describe('applyDefinitionTranslations', () => {
  it('translates label, description and nested option labels for the active locale', async () => {
    const rows = [
      row(canonicalId, {
        de: {
          label: 'Prioritaet',
          description: 'Wie dringend',
          'options.high.label': 'Hoch',
          'options.low.label': 'Niedrig',
        },
      }),
    ]
    const { result } = await localize(rows, 'de')
    expect(result[0]).toMatchObject({
      key: 'priority',
      kind: 'select',
      label: 'Prioritaet',
      description: 'Wie dringend',
      options: [
        { value: 'high', label: 'Hoch' },
        { value: 'low', label: 'Niedrig' },
      ],
    })
  })

  it('switches content with the locale', async () => {
    const rows = [
      row(canonicalId, {
        de: { label: 'Prioritaet', 'options.high.label': 'Hoch' },
        pl: { label: 'Priorytet', 'options.high.label': 'Wysoki' },
      }),
    ]
    const german = (await localize(rows, 'de')).result[0]
    const polish = (await localize(rows, 'pl')).result[0]
    expect(german.label).toBe('Prioritaet')
    expect(german.options?.[0].label).toBe('Hoch')
    expect(polish.label).toBe('Priorytet')
    expect(polish.options?.[0].label).toBe('Wysoki')
  })

  it('falls back to the base values when the locale has no translation', async () => {
    const rows = [row(canonicalId, { de: { label: 'Prioritaet' } })]
    const { result } = await localize(rows, 'fr')
    expect(result[0]).toEqual(baseItem())
  })

  it('falls back per field when the translation is partial, empty or null', async () => {
    const rows = [
      row(canonicalId, {
        de: {
          label: 'Prioritaet',
          description: '   ',
          'options.high.label': null,
        },
      }),
    ]
    const { result } = await localize(rows, 'de')
    expect(result[0].label).toBe('Prioritaet')
    expect(result[0].description).toBe('How urgent it is')
    expect(result[0].options).toEqual([
      { value: 'high', label: 'High' },
      { value: 'low', label: 'Low' },
    ])
  })

  it('can translate a description the base definition does not have', async () => {
    const item = { ...baseItem(), description: undefined }
    const rows = [row(canonicalId, { de: { description: 'Wie dringend' } })]
    const { result } = await localize(rows, 'de', { items: [item] })
    expect(result[0].description).toBe('Wie dringend')
  })

  it('does not mutate the input items or their options', async () => {
    const rows = [row(canonicalId, { de: { label: 'Prioritaet', 'options.high.label': 'Hoch' } })]
    const items = [baseItem()]
    const snapshot = JSON.parse(JSON.stringify(items))
    const { result } = await localize(rows, 'de', { items })
    expect(items).toEqual(snapshot)
    expect(result[0]).not.toBe(items[0])
    expect(result[0].options?.[0]).not.toBe(items[0].options?.[0])
  })

  it('leaves fields without options untouched', async () => {
    const item = { key: 'notes', kind: 'text', label: 'Notes' }
    const rows = [row(buildCustomFieldDefTranslationRecordId(ENTITY, 'notes'), { de: { label: 'Notizen' } })]
    const { result } = await localize(rows, 'de', {
      items: [item],
      sources: [source({ key: 'notes' })],
    })
    expect(result[0]).toEqual({ key: 'notes', kind: 'text', label: 'Notizen' })
    expect('options' in result[0]).toBe(false)
  })

  describe('scope and inheritance', () => {
    it('queries translations only for the request tenant and organization', async () => {
      const rows = [
        row(canonicalId, { de: { label: 'Tenant-level' } }),
        row(canonicalId, { de: { label: 'Other tenant' } }, { tenantId: 'tenant-2' }),
        row(canonicalId, { de: { label: 'Other org' } }, { organizationId: 'org-2' }),
      ]
      const { result, overlay } = await localize(rows, 'de')
      expect(result[0].label).toBe('Tenant-level')
      const scopes = overlay.mock.calls.map(([, options]) => [options.tenantId, options.organizationId])
      expect(scopes.every(([tenantId]) => tenantId === TENANT)).toBe(true)
      expect(scopes.map(([, organizationId]) => organizationId).sort()).toEqual([null, null, ORG, ORG].sort())
    })

    it('never exposes another tenant or organization translation', async () => {
      const rows = [
        row(canonicalId, { de: { label: 'Other tenant' } }, { tenantId: 'tenant-2' }),
        row(canonicalId, { de: { label: 'Other org' } }, { organizationId: 'org-2' }),
      ]
      const { result } = await localize(rows, 'de')
      expect(result[0].label).toBe('Priority')
    })

    it('does not consult organization-level translations without an active organization', async () => {
      const rows = [row(canonicalId, { de: { label: 'Org-level' } }, { organizationId: ORG })]
      const { result, overlay } = await localize(rows, 'de', { organizationId: null })
      expect(result[0].label).toBe('Priority')
      expect(overlay.mock.calls.every(([, options]) => options.organizationId === null)).toBe(true)
    })

    it('lets organization-level translations override tenant-level ones per field', async () => {
      const rows = [
        row(canonicalId, { de: { label: 'Tenant label', description: 'Tenant description' } }),
        row(canonicalId, { de: { label: 'Org label' } }, { organizationId: ORG }),
      ]
      const { result } = await localize(rows, 'de')
      expect(result[0].label).toBe('Org label')
      expect(result[0].description).toBe('Tenant description')
    })

    it('applies tenant-level translations to an inherited tenant-level winner', async () => {
      const rows = [row(canonicalId, { de: { label: 'Tenant label' } })]
      const { result } = await localize(rows, 'de', { sources: [source({ organizationScoped: false })] })
      expect(result[0].label).toBe('Tenant label')
    })

    it('does not leak tenant-level translations onto an organization-owned winner', async () => {
      const rows = [
        row(canonicalId, { de: { label: 'Tenant label', description: 'Tenant description' } }),
        row(canonicalId, { de: { label: 'Org label' } }, { organizationId: ORG }),
      ]
      const orgOwned = [source({ organizationScoped: true })]
      const withOrgTranslation = await localize(rows, 'de', { sources: orgOwned })
      expect(withOrgTranslation.result[0].label).toBe('Org label')
      expect(withOrgTranslation.result[0].description).toBe('How urgent it is')

      const tenantOnly = await localize([rows[0]], 'de', { sources: orgOwned })
      expect(tenantOnly.result[0]).toEqual(baseItem())
    })
  })

  describe('record identity compatibility', () => {
    it('resolves the canonical entityId:key identity written by the Translation Manager', async () => {
      expect(canonicalId).toBe('customers:customer_person_profile:priority')
      const rows = [row(canonicalId, { de: { label: 'Canonical' } })]
      const { result } = await localize(rows, 'de', { sources: [source({ definitionId: null })] })
      expect(result[0].label).toBe('Canonical')
    })

    it('still resolves translations stored under the legacy definition id', async () => {
      const rows = [row('def-1', { de: { label: 'Legacy', description: 'Legacy description' } })]
      const { result } = await localize(rows, 'de')
      expect(result[0].label).toBe('Legacy')
      expect(result[0].description).toBe('Legacy description')
    })

    it('prefers the canonical identity over the legacy definition id', async () => {
      const rows = [
        row('def-1', { de: { label: 'Legacy', description: 'Legacy description' } }),
        row(canonicalId, { de: { label: 'Canonical' } }),
      ]
      const { result } = await localize(rows, 'de')
      expect(result[0].label).toBe('Canonical')
      expect(result[0].description).toBe('Legacy description')
    })

    it('keeps a more specific scope ahead of a more specific identity', async () => {
      const rows = [
        row(canonicalId, { de: { label: 'Tenant canonical' } }),
        row('def-1', { de: { label: 'Org legacy' } }, { organizationId: ORG }),
      ]
      const { result } = await localize(rows, 'de')
      expect(result[0].label).toBe('Org legacy')
    })

    it('does not attach another field translations that share the entity', async () => {
      const rows = [row(buildCustomFieldDefTranslationRecordId(ENTITY, 'other'), { de: { label: 'Other' } })]
      const { result } = await localize(rows, 'de')
      expect(result[0].label).toBe('Priority')
    })
  })

  it('translates every item against its own winning definition', async () => {
    const rows = [
      row(canonicalId, { de: { label: 'Prioritaet' } }),
      row(buildCustomFieldDefTranslationRecordId(ENTITY, 'notes'), { de: { label: 'Notizen' } }),
    ]
    const items = [baseItem(), { key: 'notes', kind: 'text', label: 'Notes' }]
    const { result } = await localize(rows, 'de', {
      items,
      sources: [source(), source({ definitionId: 'def-2', key: 'notes' })],
    })
    expect(result.map((item) => item.label)).toEqual(['Prioritaet', 'Notizen'])
  })

  it('returns the items unchanged when sources do not line up', async () => {
    const overlay = createOverlay([])
    const items = [baseItem()]
    const result = await applyDefinitionTranslations(items, [], {
      locale: 'de',
      scope: { tenantId: TENANT, organizationId: ORG },
      container,
      overlay,
    })
    expect(result).toBe(items)
    expect(overlay).not.toHaveBeenCalled()
  })
})

describe('localizeDefinitionItemsForRequest', () => {
  const resolveLocale = (request: Request) => new URL(request.url).searchParams.get('locale')
  const scope = { tenantId: TENANT, organizationId: ORG }

  afterEach(() => {
    registerTranslationOverlayPlugin(null, null)
    resetTelemetryRuntime()
  })

  it('returns the base items when the translations module is not registered', async () => {
    const items = [baseItem()]
    const result = await localizeDefinitionItemsForRequest(items, [source()], {
      request: new Request('http://x/api/entities/definitions?locale=de'),
      scope,
      container,
    })
    expect(result).toBe(items)
  })

  it('returns the base items when the request carries no locale', async () => {
    const overlay = createOverlay([row(canonicalId, { de: { label: 'Prioritaet' } })])
    registerTranslationOverlayPlugin(overlay, resolveLocale)
    const items = [baseItem()]
    const result = await localizeDefinitionItemsForRequest(items, [source()], {
      request: new Request('http://x/api/entities/definitions'),
      scope,
      container,
    })
    expect(result).toBe(items)
    expect(overlay).not.toHaveBeenCalled()
  })

  it('localizes using the locale resolved from the request', async () => {
    registerTranslationOverlayPlugin(
      createOverlay([row(canonicalId, { de: { label: 'Prioritaet' }, pl: { label: 'Priorytet' } })]),
      resolveLocale,
    )
    const localizeFor = async (locale: string) =>
      (await localizeDefinitionItemsForRequest([baseItem()], [source()], {
        request: new Request(`http://x/api/entities/definitions?locale=${locale}`),
        scope,
        container,
      }))[0].label
    expect(await localizeFor('de')).toBe('Prioritaet')
    expect(await localizeFor('pl')).toBe('Priorytet')
    expect(await localizeFor('en')).toBe('Priority')
  })

  it('serves the base items and reports the error when the overlay fails', async () => {
    const reportError = jest.fn()
    registerTelemetryRuntime({ reportError } as unknown as TelemetryRuntime)
    registerTranslationOverlayPlugin(async () => {
      throw new Error('translations unavailable')
    }, resolveLocale)
    const items = [baseItem()]
    const result = await localizeDefinitionItemsForRequest(items, [source()], {
      request: new Request('http://x/api/entities/definitions?locale=de'),
      scope,
      container,
    })
    expect(result).toBe(items)
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ module: 'entities', code: 'entities.definitions_localization_failed' }),
    )
  })
})
