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
import { createTenantFixture, deleteTenantIfExists } from '../../feature_toggles/__integration__/featureToggleTestHelpers';
import {
  createCustomEntity,
  deleteCustomEntityIfExists,
  deleteFieldDefinitionTranslationIfExists,
  readDefinitionField,
  saveFieldDefinitions,
  saveFieldDefinitionTranslation,
  uniqueEntityId,
} from './helpers/entitiesApi';

test.describe('TC-ENTITIES-011: translated definition labels stay inside their tenant', () => {
  test('does not leak an English translation of the same entity and key between tenants', async ({ request }) => {
    const adminToken = await getAuthToken(request, 'admin');
    const superToken = await getAuthToken(request, 'superadmin');
    const { tenantId: tenantAId } = getTokenContext(adminToken);
    const stamp = `${Date.now().toString(36)}${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const entityId = uniqueEntityId('l10ntenant');
    const key = 'priority';

    let tenantBId: string | null = null;
    let orgBId: string | null = null;
    let userBId: string | null = null;
    let tenantBToken: string | null = null;

    try {
      tenantBId = await createTenantFixture(request, superToken, `E2E Localized Defs Tenant ${stamp}`);
      orgBId = await createOrganizationFixture(request, superToken, { name: `E2E Localized Defs Org ${stamp}`, tenantId: tenantBId });
      const email = `e2e-localized-defs-tenant-${stamp}@acme.com`;
      const password = 'Sched-View-1!';
      userBId = await createUserFixture(request, superToken, { email, password, organizationId: orgBId, roles: [] });
      await setUserAclVisibility(request, superToken, {
        userId: userBId,
        tenantId: tenantBId,
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
      tenantBToken = await getAuthToken(request, email, password);
      expect(getTokenContext(tenantBToken).tenantId, 'user B belongs to the second tenant').toBe(tenantBId);
      expect(tenantBId).not.toBe(tenantAId);

      for (const [token, label] of [[adminToken, 'Priorytet tenant A'], [tenantBToken, 'Priorytet tenant B']] as const) {
        expect((await createCustomEntity(request, token, { entityId, label: 'TC-ENTITIES-011 Entity' })).status()).toBe(200);
        const saved = await saveFieldDefinitions(request, token, entityId, [{ key, kind: 'text', configJson: { label } }]);
        expect(saved.status(), 'definitions.batch 200').toBe(200);
      }

      expect((await saveFieldDefinitionTranslation(request, adminToken, entityId, key, { en: { label: 'Tenant A priority' } })).status()).toBe(200);

      expect((await readDefinitionField(request, adminToken, entityId, key, 'en'))?.label, 'owner tenant').toBe('Tenant A priority');
      expect((await readDefinitionField(request, tenantBToken, entityId, key, 'en'))?.label, 'other tenant keeps its base label').toBe('Priorytet tenant B');

      expect((await saveFieldDefinitionTranslation(request, tenantBToken, entityId, key, { en: { label: 'Tenant B priority' } })).status()).toBe(200);

      expect((await readDefinitionField(request, tenantBToken, entityId, key, 'en'))?.label).toBe('Tenant B priority');
      expect((await readDefinitionField(request, adminToken, entityId, key, 'en'))?.label).toBe('Tenant A priority');
    } finally {
      await deleteFieldDefinitionTranslationIfExists(request, adminToken, entityId, key);
      await deleteFieldDefinitionTranslationIfExists(request, tenantBToken, entityId, key);
      await deleteCustomEntityIfExists(request, adminToken, entityId);
      await deleteCustomEntityIfExists(request, tenantBToken, entityId);
      await deleteUserIfExists(request, superToken, userBId);
      await deleteOrganizationIfExists(request, superToken, orgBId);
      await deleteTenantIfExists(request, superToken, tenantBId);
    }
  });
});
