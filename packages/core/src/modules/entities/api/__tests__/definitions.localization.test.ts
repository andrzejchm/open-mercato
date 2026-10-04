/** @jest-environment node */
import { applyLocalizedContent } from '@open-mercato/shared/lib/localization/resolver'
import { registerTranslationOverlayPlugin } from '@open-mercato/shared/lib/localization/overlay-plugin'
import {
  registerTelemetryRuntime,
  resetTelemetryRuntime,
  type TelemetryRuntime,
} from '@open-mercato/shared/lib/telemetry/runtime'
import { resolveLocaleFromRequest } from '@open-mercato/core/modules/translations/lib/locale'
import { GET } from '../definitions'

type TranslationRow = {
  entityId: string
  organizationId: string | null
  translations: Record<string, Record<string, unknown>>
}

const ENTITY = 'customers:customer_person_profile'
const RECORD_ID = `${ENTITY}:priority`

let translationRows: TranslationRow[]
const cacheStore = new Map<string, unknown>()

const mockRbac = { userHasAllFeatures: jest.fn(), loadAcl: jest.fn() }
const mockEm = { find: jest.fn(), findOne: jest.fn() }
const mockCache = {
  get: jest.fn(async (key: string) => (cacheStore.has(key) ? cacheStore.get(key) : null)),
  set: jest.fn(async (key: string, value: unknown) => {
    cacheStore.set(key, value)
  }),
}

jest.mock('@open-mercato/shared/lib/di/container', () => ({
  createRequestContainer: async () => ({
    resolve: (key: string) => {
      if (key === 'em') return mockEm
      if (key === 'cache') return mockCache
      if (key === 'rbacService') return mockRbac
      return null
    },
  }),
}))

jest.mock('@open-mercato/shared/lib/auth/server', () => ({
  getAuthFromRequest: async () => ({ sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1', roles: ['admin'] }),
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: async () => ({ tenantId: 'tenant-1', selectedId: 'org-1' }),
}))

jest.mock('../../lib/fieldsets', () => ({
  loadEntityFieldsetConfigs: async () => new Map(),
  CustomFieldsetDefinition: class {},
}))

jest.mock('../../lib/install-from-ce', () => ({
  installCustomEntitiesFromModules: async () => ({ processed: 0, synchronized: 0, skipped: 0, fieldChanges: 0 }),
}))

jest.mock('@open-mercato/core/modules/dictionaries/data/entities', () => ({ DictionaryEntry: 'DictionaryEntry' }))
jest.mock('@open-mercato/core/modules/currencies/data/entities', () => ({ Currency: 'Currency' }))

const overlay = jest.fn(
  async (
    items: Record<string, unknown>[],
    options: { locale: string; organizationId?: string | null },
  ) =>
    items.map((item) => {
      const row = translationRows.find(
        (candidate) =>
          candidate.entityId === String(item.id) && candidate.organizationId === (options.organizationId ?? null),
      )
      return applyLocalizedContent(item, row?.translations ?? null, options.locale)
    }),
)

const selectDefinition = {
  key: 'priority',
  kind: 'select',
  entityId: ENTITY,
  tenantId: 'tenant-1',
  organizationId: 'org-1',
  isActive: true,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  configJson: {
    label: 'Priority',
    description: 'How urgent it is',
    options: [
      { value: 'high', label: 'High' },
      { value: 'low', label: 'Low' },
    ],
  },
}

async function readDefinitions(locale?: string) {
  const query = locale ? `&locale=${locale}` : ''
  const response = await GET(new Request(`http://x/api/entities/definitions?entityId=${ENTITY}${query}`))
  expect(response.status).toBe(200)
  return (await response.json()) as { items: Array<Record<string, unknown>> }
}

describe('GET /api/entities/definitions localization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    cacheStore.clear()
    translationRows = []
    mockEm.find.mockImplementation(async (_entity: unknown, where: { deletedAt?: unknown }) =>
      where?.deletedAt === null ? [selectDefinition] : [],
    )
    mockEm.findOne.mockResolvedValue(null)
    mockRbac.userHasAllFeatures.mockResolvedValue(false)
    mockRbac.loadAcl.mockResolvedValue({ isSuperAdmin: false, features: ['*'], organizations: null })
    registerTranslationOverlayPlugin(overlay, resolveLocaleFromRequest)
  })

  afterEach(() => {
    registerTranslationOverlayPlugin(null, null)
    resetTelemetryRuntime()
  })

  it('localizes label, description and option labels for the requested locale', async () => {
    translationRows = [
      {
        entityId: RECORD_ID,
        organizationId: 'org-1',
        translations: {
          de: {
            label: 'Prioritaet',
            description: 'Wie dringend',
            'options.high.label': 'Hoch',
            'options.low.label': 'Niedrig',
          },
        },
      },
    ]
    const { items } = await readDefinitions('de')
    expect(items[0]).toMatchObject({
      key: 'priority',
      label: 'Prioritaet',
      description: 'Wie dringend',
      options: [
        { value: 'high', label: 'Hoch' },
        { value: 'low', label: 'Niedrig' },
      ],
    })
  })

  it('falls back to the base values for a missing locale, a partial translation and a blank value', async () => {
    translationRows = [
      {
        entityId: RECORD_ID,
        organizationId: 'org-1',
        translations: { de: { label: 'Prioritaet', description: '  ', 'options.high.label': 'Hoch' } },
      },
    ]
    const german = (await readDefinitions('de')).items[0]
    expect(german).toMatchObject({ label: 'Prioritaet', description: 'How urgent it is' })
    expect(german.options).toEqual([
      { value: 'high', label: 'Hoch' },
      { value: 'low', label: 'Low' },
    ])
    expect((await readDefinitions('fr')).items[0]).toMatchObject({ label: 'Priority', description: 'How urgent it is' })
    expect((await readDefinitions()).items[0].label).toBe('Priority')
  })

  it('serves every locale from one cached base payload', async () => {
    translationRows = [
      {
        entityId: RECORD_ID,
        organizationId: 'org-1',
        translations: { de: { label: 'Prioritaet' }, pl: { label: 'Priorytet' } },
      },
    ]
    const labels = [
      (await readDefinitions('de')).items[0].label,
      (await readDefinitions('pl')).items[0].label,
      (await readDefinitions('en')).items[0].label,
    ]
    expect(labels).toEqual(['Prioritaet', 'Priorytet', 'Priority'])
    expect(mockCache.set).toHaveBeenCalledTimes(1)
    const cachedItems = (Array.from(cacheStore.values())[0] as { items: Array<Record<string, unknown>> }).items
    expect(cachedItems[0].label).toBe('Priority')
  })

  it('reads translations once per request, for the caller tenant and organization, under the canonical identity', async () => {
    await readDefinitions('de')
    await readDefinitions('de')
    expect(overlay).toHaveBeenCalledTimes(2)
    for (const [records, options] of overlay.mock.calls) {
      expect(records.map((record) => record.id)).toEqual([RECORD_ID])
      expect(options).toMatchObject({
        entityType: 'entities:custom_field_def',
        tenantId: 'tenant-1',
        organizationId: 'org-1',
      })
    }
  })

  it('does not read translations for definitions the caller may not see', async () => {
    mockRbac.loadAcl.mockResolvedValue({ isSuperAdmin: false, features: [], organizations: null })
    const { items } = await readDefinitions('de')
    expect(items).toEqual([])
    expect(overlay).not.toHaveBeenCalled()
  })

  it('serves the base definitions and reports the error when the translation read fails', async () => {
    const reportError = jest.fn()
    registerTelemetryRuntime({ reportError } as unknown as TelemetryRuntime)
    overlay.mockRejectedValueOnce(new Error('translations unavailable'))
    const { items } = await readDefinitions('de')
    expect(items[0].label).toBe('Priority')
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ code: 'entities.definitions_localization_failed' }),
    )
  })
})
