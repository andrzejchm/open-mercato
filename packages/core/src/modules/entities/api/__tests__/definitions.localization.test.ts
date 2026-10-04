/** @jest-environment node */
import { applyLocalizedContent } from '@open-mercato/shared/lib/localization/resolver'
import { registerTranslationOverlayPlugin } from '@open-mercato/shared/lib/localization/overlay-plugin'
import { resolveLocaleFromRequest } from '@open-mercato/core/modules/translations/lib/locale'
import { GET } from '../definitions'
import { buildCustomFieldDefTranslationRecordId } from '../../lib/definition-translation-identity'

type AuthState = { sub: string; tenantId: string; orgId: string; roles: string[] }
type StoredTranslation = {
  entityId: string
  tenantId: string | null
  organizationId: string | null
  translations: Record<string, Record<string, unknown>>
}

const ENTITY = 'customers:customer_person_profile'
const canonicalId = buildCustomFieldDefTranslationRecordId(ENTITY, 'priority')

let auth: AuthState
let translationRows: StoredTranslation[]
let activeDefinitions: Array<Record<string, unknown>>
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
  getAuthFromRequest: async () => auth,
}))

jest.mock('@open-mercato/core/modules/directory/utils/organizationScope', () => ({
  resolveOrganizationScopeForRequest: async () => ({ tenantId: auth.tenantId, selectedId: auth.orgId }),
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
    options: { entityType: string; locale: string; tenantId?: string | null; organizationId?: string | null },
  ) =>
    items.map((item) => {
      const match = translationRows.find(
        (row) =>
          row.entityId === String(item.id) &&
          row.tenantId === (options.tenantId ?? null) &&
          row.organizationId === (options.organizationId ?? null),
      )
      return applyLocalizedContent(item, match?.translations ?? null, options.locale)
    }),
)

function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: 'def-tenant',
    key: 'priority',
    kind: 'select',
    entityId: ENTITY,
    tenantId: 'tenant-1',
    organizationId: null,
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
    ...overrides,
  }
}

function translation(
  translations: StoredTranslation['translations'],
  scope: { tenantId?: string; organizationId?: string | null } = {},
  entityId = canonicalId,
): StoredTranslation {
  return {
    entityId,
    tenantId: scope.tenantId ?? 'tenant-1',
    organizationId: scope.organizationId ?? null,
    translations,
  }
}

async function readDefinitions(locale?: string) {
  const suffix = locale ? `&locale=${locale}` : ''
  const response = await GET(new Request(`http://x/api/entities/definitions?entityId=${ENTITY}${suffix}`))
  expect(response.status).toBe(200)
  return (await response.json()) as { items: Array<Record<string, any>> }
}

describe('GET /api/entities/definitions localization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    cacheStore.clear()
    auth = { sub: 'user-1', tenantId: 'tenant-1', orgId: 'org-1', roles: ['admin'] }
    translationRows = []
    activeDefinitions = [definition()]
    mockEm.find.mockImplementation(async (_entity: unknown, where: { deletedAt?: unknown }) =>
      where?.deletedAt === null ? activeDefinitions : [],
    )
    mockEm.findOne.mockResolvedValue(null)
    mockRbac.userHasAllFeatures.mockResolvedValue(false)
    mockRbac.loadAcl.mockResolvedValue({ isSuperAdmin: false, features: ['*'], organizations: null })
    registerTranslationOverlayPlugin(overlay, resolveLocaleFromRequest)
  })

  afterEach(() => {
    registerTranslationOverlayPlugin(null, null)
  })

  it('localizes label, description and option labels for the requested locale', async () => {
    translationRows = [
      translation({
        de: {
          label: 'Prioritaet',
          description: 'Wie dringend',
          'options.high.label': 'Hoch',
          'options.low.label': 'Niedrig',
        },
      }),
    ]
    const { items } = await readDefinitions('de')
    expect(items).toHaveLength(1)
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

  it('serves the base definition when the locale has no translation or no locale is requested', async () => {
    translationRows = [translation({ de: { label: 'Prioritaet' } })]
    const french = await readDefinitions('fr')
    expect(french.items[0]).toMatchObject({ label: 'Priority', description: 'How urgent it is' })
    expect(french.items[0].options).toEqual([
      { value: 'high', label: 'High' },
      { value: 'low', label: 'Low' },
    ])
    const unspecified = await readDefinitions()
    expect(unspecified.items[0].label).toBe('Priority')
  })

  it('keeps the base values in a cache hit and switches content when the locale changes', async () => {
    translationRows = [
      translation({
        de: { label: 'Prioritaet', 'options.high.label': 'Hoch' },
        pl: { label: 'Priorytet', 'options.high.label': 'Wysoki' },
      }),
    ]
    const german = await readDefinitions('de')
    const firstDefinitionReads = mockEm.find.mock.calls.length
    const polish = await readDefinitions('pl')
    const english = await readDefinitions('en')

    expect(mockEm.find.mock.calls.length).toBe(firstDefinitionReads)
    expect(mockCache.set).toHaveBeenCalledTimes(1)
    expect(german.items[0].label).toBe('Prioritaet')
    expect(german.items[0].options[0].label).toBe('Hoch')
    expect(polish.items[0].label).toBe('Priorytet')
    expect(polish.items[0].options[0].label).toBe('Wysoki')
    expect(english.items[0].label).toBe('Priority')
    expect(english.items[0].options[0].label).toBe('High')

    const [cached] = Array.from(cacheStore.values()) as Array<{ body: { items: Array<Record<string, any>> } }>
    expect(cached.body.items[0].label).toBe('Priority')
    expect(cached.body.items[0].options[0].label).toBe('High')
  })

  it('reflects a translation edit on the next read without waiting for cache expiry', async () => {
    translationRows = [translation({ de: { label: 'Prioritaet' } })]
    expect((await readDefinitions('de')).items[0].label).toBe('Prioritaet')
    translationRows = [translation({ de: { label: 'Dringlichkeit' } })]
    expect((await readDefinitions('de')).items[0].label).toBe('Dringlichkeit')
    expect(mockCache.set).toHaveBeenCalledTimes(1)
  })

  it('does not expose localization bookkeeping in the response or the cached body', async () => {
    translationRows = [translation({ de: { label: 'Prioritaet' } })]
    const body = await readDefinitions('de')
    expect(JSON.stringify(body)).not.toContain('__localizationSource')
    expect(JSON.stringify(body)).not.toContain('def-tenant')
    expect(Object.keys(body)).not.toContain('sources')
    const [cached] = Array.from(cacheStore.values()) as Array<{ body: { items: Array<Record<string, unknown>> } }>
    expect(JSON.stringify(cached.body)).not.toContain('__localizationSource')
  })

  it('ignores a cache entry written in the previous payload format', async () => {
    const previousFormat = { items: [{ key: 'priority', label: 'Stale', entityId: ENTITY }], fieldsetsByEntity: {}, entitySettings: {} }
    mockCache.get.mockResolvedValueOnce(previousFormat)
    translationRows = [translation({ de: { label: 'Prioritaet' } })]
    const { items } = await readDefinitions('de')
    expect(items[0].label).toBe('Prioritaet')
    expect(mockCache.set).toHaveBeenCalledTimes(1)
  })

  describe('scope and cache isolation', () => {
    it('queries translations with the caller tenant and organization only', async () => {
      translationRows = [translation({ de: { label: 'Prioritaet' } })]
      await readDefinitions('de')
      expect(overlay).toHaveBeenCalled()
      for (const [, options] of overlay.mock.calls) {
        expect(options.tenantId).toBe('tenant-1')
        expect([null, 'org-1']).toContain(options.organizationId)
        expect(options.entityType).toBe('entities:custom_field_def')
      }
    })

    it('does not serve one tenant cached definitions or translations to another tenant', async () => {
      translationRows = [
        translation({ de: { label: 'Tenant one' } }),
        translation({ de: { label: 'Tenant two' } }, { tenantId: 'tenant-2', organizationId: null }),
      ]
      activeDefinitions = [
        definition(),
        definition({
          id: 'def-tenant-2',
          tenantId: 'tenant-2',
          configJson: { label: 'Priority two', options: [] },
        }),
      ]
      const tenantOne = await readDefinitions('de')
      auth = { sub: 'user-2', tenantId: 'tenant-2', orgId: 'org-2', roles: ['admin'] }
      const tenantTwo = await readDefinitions('de')

      expect(tenantOne.items.map((item) => item.label)).toEqual(['Tenant one'])
      expect(tenantTwo.items.map((item) => item.label)).toEqual(['Tenant two'])
      expect(mockCache.set).toHaveBeenCalledTimes(2)
      const [firstKey, secondKey] = mockCache.set.mock.calls.map(([key]) => key)
      expect(firstKey).not.toBe(secondKey)
    })

    it('does not apply another organization translation to the same tenant', async () => {
      translationRows = [translation({ de: { label: 'Org two label' } }, { organizationId: 'org-2' })]
      const { items } = await readDefinitions('de')
      expect(items[0].label).toBe('Priority')
    })

    it('applies organization translations over tenant translations for the caller organization', async () => {
      translationRows = [
        translation({ de: { label: 'Tenant label', description: 'Tenant description' } }),
        translation({ de: { label: 'Org label' } }, { organizationId: 'org-1' }),
      ]
      const { items } = await readDefinitions('de')
      expect(items[0].label).toBe('Org label')
      expect(items[0].description).toBe('Tenant description')
    })
  })

  describe('inherited definition winner', () => {
    const tenantDefinition = definition()
    const orgDefinition = definition({
      id: 'def-org',
      organizationId: 'org-1',
      updatedAt: new Date('2026-02-01T00:00:00Z'),
      configJson: {
        label: 'Priority (org override)',
        options: [{ value: 'high', label: 'Urgent' }],
      },
    })

    it('translates the organization override and keeps its own base values as fallback', async () => {
      activeDefinitions = [tenantDefinition, orgDefinition]
      translationRows = [
        translation({ de: { label: 'Tenant label', 'options.high.label': 'Tenant hoch' } }),
        translation({ de: { label: 'Org label' } }, { organizationId: 'org-1' }),
      ]
      const { items } = await readDefinitions('de')
      expect(items).toHaveLength(1)
      expect(items[0].label).toBe('Org label')
      expect(items[0].description).toBeUndefined()
      expect(items[0].options).toEqual([{ value: 'high', label: 'Urgent' }])
    })

    it('does not put tenant-level translations on the organization override', async () => {
      activeDefinitions = [tenantDefinition, orgDefinition]
      translationRows = [translation({ de: { label: 'Tenant label' } })]
      const { items } = await readDefinitions('de')
      expect(items).toHaveLength(1)
      expect(items[0].label).toBe('Priority (org override)')
    })

    it('translates the inherited tenant-level definition when no override exists', async () => {
      activeDefinitions = [tenantDefinition]
      translationRows = [translation({ de: { label: 'Tenant label' } })]
      const { items } = await readDefinitions('de')
      expect(items[0].label).toBe('Tenant label')
    })

    it('still resolves translations stored under the legacy definition id', async () => {
      activeDefinitions = [tenantDefinition]
      translationRows = [translation({ de: { label: 'Legacy label' } }, {}, 'def-tenant')]
      const { items } = await readDefinitions('de')
      expect(items[0].label).toBe('Legacy label')
    })

    it('does not resurrect a tombstoned definition through its translations', async () => {
      activeDefinitions = [tenantDefinition]
      mockEm.find.mockImplementation(async (_entity: unknown, where: { deletedAt?: unknown }) =>
        where?.deletedAt === null
          ? activeDefinitions
          : [definition({ id: 'tombstone', organizationId: 'org-1', deletedAt: new Date() })],
      )
      translationRows = [translation({ de: { label: 'Tenant label' } })]
      const { items } = await readDefinitions('de')
      expect(items).toEqual([])
    })
  })

  it('serves the base definitions when the translation overlay fails', async () => {
    overlay.mockRejectedValueOnce(new Error('translations unavailable'))
    translationRows = [translation({ de: { label: 'Prioritaet' } })]
    const { items } = await readDefinitions('de')
    expect(items[0].label).toBe('Priority')
  })
})
