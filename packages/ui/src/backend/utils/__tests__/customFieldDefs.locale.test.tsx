/**
 * @jest-environment jsdom
 */
import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { I18nProvider } from '@open-mercato/shared/lib/i18n/context'
import { useCustomFieldDefs } from '../customFieldDefs'

function renderDefs(queryClient: QueryClient, locale: string, fetchImpl: typeof fetch) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider locale={locale} dict={{}}>{children}</I18nProvider>
    </QueryClientProvider>
  )
  return renderHook(() => useCustomFieldDefs('customers:customer_person_profile', { fetchImpl }), { wrapper })
}

describe('useCustomFieldDefs locale partitioning', () => {
  it('refetches instead of reusing the other locale cache entry after a language switch', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const labels = ['Priority', 'Prioritaet']
    const fetchImpl = jest.fn(async () => ({
      json: async () => ({ items: [{ key: 'priority', kind: 'text', label: labels.shift() }] }),
    })) as unknown as typeof fetch

    const english = renderDefs(queryClient, 'en', fetchImpl)
    await waitFor(() => expect(english.result.current.data?.[0]?.label).toBe('Priority'))
    const german = renderDefs(queryClient, 'de', fetchImpl)
    await waitFor(() => expect(german.result.current.data?.[0]?.label).toBe('Prioritaet'))

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
