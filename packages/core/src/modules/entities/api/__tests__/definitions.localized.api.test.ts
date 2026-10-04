/** @jest-environment node */
import { GET } from '../definitions'
import { applyLocalizedContent } from '@open-mercato/shared/lib/localization/resolver'
import { registerTranslationOverlayPlugin } from '@open-mercato/shared/lib/localization/overlay-plugin'
import { resolveLocaleFromRequest } from '@open-mercato/core/modules/translations/lib/locale'

type TranslationRow = {
  entityId: string
  tenantId: string | null
  organizationId: string | null
  translations: Record<string, Record<string, unknown>>
}

const ENTITY_ID = 'customers:customer_person'
const DEFINITION_ENTITY_ID = `${ENTITY_ID}:priority_level`

const loadEntityFieldsetConfigsMock = jest.fn(async () => new Map())
const mockRbac = { userHasAllFeatures: jest.fn(), loadAcl: jest.fn() }
const mockResolveOrganizationScopeForRequest = jest.fn(async () => ({ tenantId: 'tenant-1', selectedId: 'org-1' }))

const mockEm = {
  find: jest.fn(),
  findOne: jest.fn(),
}

const cacheStore = new Map<string, unknown>()
const mockCache = {
  get: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
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
  resolveOrganizationScopeForRequest: (...args: unknown[]) => mockResolveOrganizationScopeForRequest(...args),
}))

jest.mock('../../lib/fieldsets', () => ({
  loadEntityFieldsetConfigs: (...args: unknown[]) => loadEntityFieldsetConfigsMock(...args),
  CustomFieldsetDefinition: class {},
}))

jest.mock('../../lib/install-from-ce', () => ({
  installCustomEntitiesFromModules: jest.fn(async () => ({ processed: 0, synchronized: 0, skipped: 0, fieldChanges: 0 })),
}))

jest.mock('@open-mercato/core/modules/dictionaries/data/entities', () => ({ DictionaryEntry: 'DictionaryEntry' }))
jest.mock('@open-mercato/core/modules/currencies/data/entities', () => ({ Currency: 'Currency' }))

let translationRows: TranslationRow[] = []

const overlayMock = jest.fn(async (
  items: Record<string, unknown>[],
  options: { entityType: string; locale: string; tenantId?: string | null; organizationId?: string | null },
) =>
  items.map((item) => {
    const row = translationRows.find(
      (candidate) =>
        options.entityType === 'entities:custom_field_def' &&
        candidate.entityId === String(item.id) &&
        candidate.tenantId === (options.tenantId ?? null) &&
        candidate.organizationId === (options.organizationId ?? null),
    )
    return applyLocalizedContent(item, row?.translations ?? null, options.locale)
  }),
)

function priorityDefinition() {
  return {
    key: 'priority_level',
    kind: 'select',
    entityId: ENTITY_ID,
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    configJson: {
      label: 'Priority',
      description: 'Customer priority',
      options: [
        { value: 'high', label: 'High' },
        { value: 'low', label: 'Low' },
      ],
    },
  }
}

function notesDefinition() {
  return {
    key: 'notes',
    kind: 'text',
    entityId: ENTITY_ID,
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    configJson: { label: 'Notes' },
  }
}

function polishRow(overrides: Partial<TranslationRow> = {}): TranslationRow {
  return {
    entityId: DEFINITION_ENTITY_ID,
    tenantId: 'tenant-1',
    organizationId: 'org-1',
    translations: {
      pl: {
        label: 'Priorytet',
        description: 'Priorytet klienta',
        'options.high.label': 'Wysoki',
        'options.low.label': 'Niski',
      },
    },
    ...overrides,
  }
}

async function fetchDefinitions(query = 'locale=pl', headers: Record<string, string> = {}) {
  const response = await GET(
    new Request(`http://x/api/entities/definitions?entityId=${ENTITY_ID}${query ? `&${query}` : ''}`, { headers }),
  )
  expect(response.status).toBe(200)
  const body = await response.json()
  const items = body.items as Array<Record<string, any>>
  return {
    response,
    body,
    priority: items.find((item) => item.key === 'priority_level')!,
    notes: items.find((item) => item.key === 'notes')!,
  }
}

describe('entities/definitions API locale-aware read', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    cacheStore.clear()
    translationRows = []
    registerTranslationOverlayPlugin(overlayMock, resolveLocaleFromRequest)
    mockEm.find.mockImplementation(async (_entity: unknown, where: { deletedAt?: unknown }) =>
      where?.deletedAt === null ? [priorityDefinition(), notesDefinition()] : [],
    )
    mockEm.findOne.mockResolvedValue(null)
    mockRbac.userHasAllFeatures.mockResolvedValue(false)
    mockRbac.loadAcl.mockResolvedValue({ isSuperAdmin: false, features: ['*'], organizations: null })
    mockResolveOrganizationScopeForRequest.mockResolvedValue({ tenantId: 'tenant-1', selectedId: 'org-1' })
  })

  afterAll(() => {
    registerTranslationOverlayPlugin(null, null)
  })

  it('serves translated label, description and option labels for the requested locale and keeps the shape', async () => {
    translationRows = [polishRow()]

    const { priority, notes } = await fetchDefinitions('locale=pl')

    expect(priority.label).toBe('Priorytet')
    expect(priority.description).toBe('Priorytet klienta')
    expect(priority.options).toEqual([
      { value: 'high', label: 'Wysoki' },
      { value: 'low', label: 'Niski' },
    ])
    expect(notes.label).toBe('Notes')
    expect(priority).not.toHaveProperty('_locale')
    expect(priority).not.toHaveProperty('_translated')
    expect(priority).not.toHaveProperty('id')
  })

  it('returns base text for a locale without a translation and when no locale resolves', async () => {
    translationRows = [polishRow()]

    const english = await fetchDefinitions('locale=en')
    expect(english.priority.label).toBe('Priority')
    expect(english.priority.options).toEqual([
      { value: 'high', label: 'High' },
      { value: 'low', label: 'Low' },
    ])

    overlayMock.mockClear()
    const unspecified = await fetchDefinitions('')
    expect(unspecified.priority.label).toBe('Priority')
    expect(overlayMock).not.toHaveBeenCalled()
  })

  it('resolves the locale from the x-locale header, the locale cookie and Accept-Language', async () => {
    translationRows = [polishRow()]

    expect((await fetchDefinitions('', { 'x-locale': 'pl' })).priority.label).toBe('Priorytet')
    expect((await fetchDefinitions('', { cookie: 'locale=pl' })).priority.label).toBe('Priorytet')
    expect((await fetchDefinitions('', { 'accept-language': 'pl' })).priority.label).toBe('Priorytet')
  })

  it('falls back to base text for missing keys, null values and empty strings', async () => {
    translationRows = [
      polishRow({
        translations: {
          pl: {
            label: '   ',
            description: null,
            'options.high.label': 'Wysoki',
          },
        },
      }),
    ]

    const { priority } = await fetchDefinitions('locale=pl')

    expect(priority.label).toBe('Priority')
    expect(priority.description).toBe('Customer priority')
    expect(priority.options).toEqual([
      { value: 'high', label: 'Wysoki' },
      { value: 'low', label: 'Low' },
    ])
  })

  it('never applies translation rows of another tenant', async () => {
    translationRows = [polishRow({ tenantId: 'tenant-2' })]

    const { priority } = await fetchDefinitions('locale=pl')

    expect(priority.label).toBe('Priority')
    for (const [, options] of overlayMock.mock.calls) {
      expect(options.tenantId).toBe('tenant-1')
    }
  })

  it('never applies translation rows of another organization', async () => {
    translationRows = [polishRow({ organizationId: 'org-2' })]

    const { priority } = await fetchDefinitions('locale=pl')

    expect(priority.label).toBe('Priority')
    for (const [, options] of overlayMock.mock.calls) {
      expect(['org-1', null]).toContain(options.organizationId ?? null)
    }
  })

  it('falls back to the tenant-wide row when the request organization has no translation', async () => {
    translationRows = [polishRow({ organizationId: null })]

    const { priority } = await fetchDefinitions('locale=pl')

    expect(priority.label).toBe('Priorytet')
    expect(priority.options[0]).toEqual({ value: 'high', label: 'Wysoki' })
  })

  it('prefers the request organization row and fills gaps from the tenant-wide row', async () => {
    translationRows = [
      polishRow({
        organizationId: 'org-1',
        translations: { pl: { label: 'Priorytet org' } },
      }),
      polishRow({
        organizationId: null,
        translations: { pl: { label: 'Priorytet tenant', description: 'Opis tenant' } },
      }),
    ]

    const { priority } = await fetchDefinitions('locale=pl')

    expect(priority.label).toBe('Priorytet org')
    expect(priority.description).toBe('Opis tenant')
  })

  it('keeps the shared cache base-locale and localizes each request after the cache read', async () => {
    translationRows = [
      polishRow({
        translations: {
          pl: { label: 'Priorytet', description: 'Priorytet klienta', 'options.high.label': 'Wysoki' },
          en: { label: 'Priority (EN)', 'options.high.label': 'High (EN)' },
        },
      }),
    ]

    const polish = await fetchDefinitions('locale=pl')
    expect(polish.priority.label).toBe('Priorytet')
    expect(mockCache.set).toHaveBeenCalledTimes(1)
    const cachedBody = mockCache.set.mock.calls[0][1] as { items: Array<Record<string, any>> }
    const cachedPriority = cachedBody.items.find((item) => item.key === 'priority_level')!
    expect(cachedPriority.label).toBe('Priority')
    expect(cachedPriority.description).toBe('Customer priority')
    expect(cachedPriority.options[0]).toEqual({ value: 'high', label: 'High' })
    const cacheKey = mockCache.set.mock.calls[0][0]
    expect(cacheKey).not.toMatch(/pl|locale/i)
    const snapshot = JSON.parse(JSON.stringify(cachedBody))

    mockEm.find.mockClear()
    const english = await fetchDefinitions('locale=en')
    expect(mockEm.find).not.toHaveBeenCalled()
    expect(english.priority.label).toBe('Priority (EN)')
    expect(english.priority.options[0]).toEqual({ value: 'high', label: 'High (EN)' })
    expect(english.priority.description).toBe('Customer priority')

    const polishAgain = await fetchDefinitions('locale=pl')
    expect(polishAgain.priority.label).toBe('Priorytet')

    const base = await fetchDefinitions('')
    expect(base.priority.label).toBe('Priority')
    expect(mockCache.set).toHaveBeenCalledTimes(1)
    expect(JSON.parse(JSON.stringify(cacheStore.get(cacheKey)))).toEqual(snapshot)
  })

  it('localizes responses that bypass the shared cache because of a fieldset filter', async () => {
    translationRows = [polishRow()]
    mockEm.find.mockImplementation(async (_entity: unknown, where: { deletedAt?: unknown }) =>
      where?.deletedAt === null
        ? [{ ...priorityDefinition(), configJson: { ...priorityDefinition().configJson, fieldset: 'sales' } }]
        : [],
    )

    const { priority } = await fetchDefinitions('locale=pl&fieldset=sales')

    expect(mockCache.set).not.toHaveBeenCalled()
    expect(priority.label).toBe('Priorytet')
  })

  it('marks localized responses as varying on the locale request headers', async () => {
    translationRows = [polishRow()]

    const { response } = await fetchDefinitions('locale=pl')

    const vary = (response.headers.get('vary') ?? '').toLowerCase()
    expect(vary).toContain('accept-language')
    expect(vary).toContain('cookie')
    expect(vary).toContain('x-locale')
  })

  it('behaves exactly as before when the translations module is not registered', async () => {
    registerTranslationOverlayPlugin(null, null)
    translationRows = [polishRow()]

    const { response, priority } = await fetchDefinitions('locale=pl')

    expect(priority.label).toBe('Priority')
    expect(priority.options[0]).toEqual({ value: 'high', label: 'High' })
    expect(response.headers.get('vary')).toBeNull()
    expect(overlayMock).not.toHaveBeenCalled()
  })

  it('serves base text instead of failing when the translation lookup throws', async () => {
    overlayMock.mockRejectedValueOnce(new Error('translations table missing'))

    const { priority } = await fetchDefinitions('locale=pl')

    expect(priority.label).toBe('Priority')
  })
})
