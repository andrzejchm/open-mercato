/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { I18nProvider } from '@open-mercato/shared/lib/i18n/context'
import { useCustomFieldDefs } from '../customFieldDefs'

const labelsByLocale: Record<string, string> = { en: 'Priority', de: 'Prioritaet' }

function createFetchStub() {
  return jest.fn(async (_url: string) => {
    const locale = document.documentElement.dataset.testLocale ?? 'en'
    return { json: async () => ({ items: [{ key: 'priority', kind: 'text', label: labelsByLocale[locale] }] }) }
  })
}

function wrapperFor(queryClient: QueryClient, locale: string) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <I18nProvider locale={locale} dict={{}}>{children}</I18nProvider>
      </QueryClientProvider>
    )
  }
}

describe('useCustomFieldDefs locale partitioning', () => {
  afterEach(() => {
    delete document.documentElement.dataset.testLocale
  })

  it('refetches definitions when the active locale changes instead of reusing the other locale cache entry', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const fetchStub = createFetchStub()

    document.documentElement.dataset.testLocale = 'en'
    const english = renderHook(
      () => useCustomFieldDefs('customers:customer_person_profile', { fetchImpl: fetchStub as unknown as typeof fetch }),
      { wrapper: wrapperFor(queryClient, 'en') },
    )
    await waitFor(() => expect(english.result.current.data?.[0]?.label).toBe('Priority'))

    document.documentElement.dataset.testLocale = 'de'
    const german = renderHook(
      () => useCustomFieldDefs('customers:customer_person_profile', { fetchImpl: fetchStub as unknown as typeof fetch }),
      { wrapper: wrapperFor(queryClient, 'de') },
    )
    await waitFor(() => expect(german.result.current.data?.[0]?.label).toBe('Prioritaet'))

    expect(fetchStub).toHaveBeenCalledTimes(2)
    const cachedKeys = queryClient.getQueryCache().getAll().map((query) => query.queryKey)
    expect(cachedKeys).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['locale:en']),
        expect.arrayContaining(['locale:de']),
      ]),
    )
  })
})
