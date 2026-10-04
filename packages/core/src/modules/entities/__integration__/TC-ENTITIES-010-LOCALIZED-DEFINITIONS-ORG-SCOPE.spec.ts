import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { getAuthToken } from '@open-mercato/core/helpers/integration/api';
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
  deleteFieldDefinitionTranslationIfExists,
  readDefinitionField,
  saveFieldDefinitions,
  saveFieldDefinitionTranslation,
  uniqueEntityId,
} from './helpers/entitiesApi';

test.describe('TC-ENTITIES-010: translated definition labels stay inside their organization', () => {
  test('does not leak a translation between organizations', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin');
    const superToken = await getAuthToken(request, 'superadmin');
    const { tenantId } = getTokenContext(adminToken);
    const stamp = `${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const entityId = uniqueEntityId('l10norg');
    const key = 'priority';

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

      for (const [token, label] of [[adminToken, 'Priorytet admin'], [orgToken, 'Priorytet org']] as const) {
        expect((await createCustomEntity(request, token, { entityId, label: 'TC-ENTITIES-010 Entity' })).status()).toBe(200);
        const saved = await saveFieldDefinitions(request, token, entityId, [{ key, kind: 'text', configJson: { label } }]);
        expect(saved.status(), 'definitions.batch 200').toBe(200);
      }

      expect((await saveFieldDefinitionTranslation(request, adminToken, entityId, key, { en: { label: 'Admin priority' } })).status()).toBe(200);

      expect((await readDefinitionField(request, adminToken, entityId, key, 'en'))?.label, 'owner organization').toBe('Admin priority');
      expect((await readDefinitionField(request, orgToken, entityId, key, 'en'))?.label, 'other organization keeps its base label').toBe('Priorytet org');

      expect((await saveFieldDefinitionTranslation(request, orgToken, entityId, key, { en: { label: 'Org priority' } })).status()).toBe(200);

      expect((await readDefinitionField(request, orgToken, entityId, key, 'en'))?.label).toBe('Org priority');
      expect((await readDefinitionField(request, adminToken, entityId, key, 'en'))?.label).toBe('Admin priority');
    } finally {
      await deleteFieldDefinitionTranslationIfExists(request, adminToken, entityId, key);
      await deleteFieldDefinitionTranslationIfExists(request, orgToken, entityId, key);
      await deleteCustomEntityIfExists(request, adminToken, entityId);
      await deleteCustomEntityIfExists(request, orgToken, entityId);
      await deleteUserIfExists(request, superToken, userId);
      await deleteOrganizationIfExists(request, superToken, orgId);
    }
  });
});
