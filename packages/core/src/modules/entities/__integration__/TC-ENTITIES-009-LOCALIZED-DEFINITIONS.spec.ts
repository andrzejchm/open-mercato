import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { apiRequest, getAuthToken } from '@open-mercato/core/helpers/integration/api';
import { getTokenContext } from '@open-mercato/core/helpers/integration/generalFixtures';
import {
  createOrganizationFixture,
  createUserFixture,
  deleteOrganizationIfExists,
  deleteUserIfExists,
  setUserAclVisibility,
} from '@open-mercato/core/helpers/integration/authFixtures';
import {
  createCustomEntity,
  deleteCustomEntityIfExists,
  saveFieldDefinitions,
  uniqueEntityId,
} from './helpers/entitiesApi';

const KEY = 'priority';

function translationPath(entityId: string): string {
  return `/api/translations/${encodeURIComponent('entities:custom_field_def')}/${encodeURIComponent(`${entityId}:${KEY}`)}`;
}

async function readDefinition(request: APIRequestContext, token: string, entityId: string, locale?: string) {
  const response = await apiRequest(request, 'GET', `/api/entities/definitions?entityId=${encodeURIComponent(entityId)}`, {
    token,
    headers: locale ? { Cookie: `locale=${locale}` } : undefined,
  });
  expect(response.status(), 'GET /api/entities/definitions 200').toBe(200);
  const body = (await response.json()) as {
    items?: Array<{ key: string; label?: string; description?: string; options?: Array<{ value: string; label: string }> }>;
  };
  return body.items?.find((item) => item.key === KEY);
}

test.describe('TC-ENTITIES-009: GET /api/entities/definitions serves translated labels', () => {
  test('localizes by locale cookie and falls back to the base value', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const entityId = uniqueEntityId('l10n');

    try {
      expect((await createCustomEntity(request, token, { entityId, label: 'TC-ENTITIES-009 Entity' })).status()).toBe(200);
      const saved = await saveFieldDefinitions(request, token, entityId, [
        {
          key: KEY,
          kind: 'select',
          configJson: {
            label: 'Priorytet',
            description: 'Jak pilne',
            options: [
              { value: 'high', label: 'Wysoki' },
              { value: 'low', label: 'Niski' },
            ],
          },
        },
      ]);
      expect(saved.status(), 'definitions.batch 200').toBe(200);
      const translated = await apiRequest(request, 'PUT', translationPath(entityId), {
        token,
        data: { en: { label: 'Priority', description: 'How urgent it is', 'options.high.label': 'High' } },
      });
      expect(translated.status(), 'PUT translation 200').toBe(200);

      const english = await readDefinition(request, token, entityId, 'en');
      expect(english).toMatchObject({ label: 'Priority', description: 'How urgent it is' });
      expect(english?.options).toEqual([
        { value: 'high', label: 'High' },
        { value: 'low', label: 'Niski' },
      ]);

      expect((await readDefinition(request, token, entityId, 'pl'))?.label, 'base locale').toBe('Priorytet');
      expect((await readDefinition(request, token, entityId))?.label, 'no locale').toBe('Priorytet');
      expect((await readDefinition(request, token, entityId, 'en'))?.label, 'english again after the base reads').toBe('Priority');
    } finally {
      await apiRequest(request, 'DELETE', translationPath(entityId), { token }).catch(() => undefined);
      await deleteCustomEntityIfExists(request, token, entityId);
    }
  });

  test('does not apply a translation saved in another organization', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin');
    const superToken = await getAuthToken(request, 'superadmin');
    const { tenantId } = getTokenContext(adminToken);
    const stamp = `${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const entityId = uniqueEntityId('l10norg');

    let orgId: string | null = null;
    let userId: string | null = null;
    let orgToken: string | null = null;

    try {
      orgId = await createOrganizationFixture(request, superToken, { name: `E2E Localized Defs Org ${stamp}`, tenantId });
      const email = `e2e-localized-defs-${stamp}@acme.com`;
      const password = 'Sched-View-1!';
      userId = await createUserFixture(request, superToken, { email, password, organizationId: orgId, roles: [] });
      await setUserAclVisibility(request, superToken, {
        userId,
        organizations: null,
        features: [
          'entities.definitions.view',
          'entities.definitions.manage',
          'entities.records.view',
          'entities.records.manage',
          'translations.view',
          'translations.manage',
        ],
      });
      orgToken = await getAuthToken(request, email, password);

      for (const token of [adminToken, orgToken]) {
        expect((await createCustomEntity(request, token, { entityId, label: 'TC-ENTITIES-009 Entity' })).status()).toBe(200);
        const saved = await saveFieldDefinitions(request, token, entityId, [{ key: KEY, kind: 'text', configJson: { label: 'Priorytet' } }]);
        expect(saved.status(), 'definitions.batch 200').toBe(200);
      }
      const translated = await apiRequest(request, 'PUT', translationPath(entityId), {
        token: adminToken,
        data: { en: { label: 'Admin priority' } },
      });
      expect(translated.status(), 'PUT translation 200').toBe(200);

      expect((await readDefinition(request, adminToken, entityId, 'en'))?.label, 'owner organization').toBe('Admin priority');
      expect((await readDefinition(request, orgToken, entityId, 'en'))?.label, 'other organization').toBe('Priorytet');
    } finally {
      await apiRequest(request, 'DELETE', translationPath(entityId), { token: adminToken }).catch(() => undefined);
      await deleteCustomEntityIfExists(request, adminToken, entityId);
      if (orgToken) await deleteCustomEntityIfExists(request, orgToken, entityId);
      await deleteUserIfExists(request, superToken, userId);
      await deleteOrganizationIfExists(request, superToken, orgId);
    }
  });
});
