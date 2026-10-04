import { expect, test } from '@playwright/test';
import { getAuthToken } from '@open-mercato/core/helpers/integration/api';
import {
  createCustomEntity,
  deleteCustomEntityIfExists,
  deleteFieldDefinitionTranslationIfExists,
  readDefinitionField,
  saveFieldDefinitions,
  saveFieldDefinitionTranslation,
  uniqueEntityId,
} from './helpers/entitiesApi';

test.describe('TC-ENTITIES-009: GET /api/entities/definitions serves translated labels', () => {
  test('localizes per locale, keeps base fallback and survives a cached read', async ({ request }) => {
    const token = await getAuthToken(request, 'admin');
    const entityId = uniqueEntityId('l10n');
    const key = 'priority';

    try {
      expect((await createCustomEntity(request, token, { entityId, label: 'TC-ENTITIES-009 Entity' })).status()).toBe(200);
      const saved = await saveFieldDefinitions(request, token, entityId, [
        {
          key,
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
      const translated = await saveFieldDefinitionTranslation(request, token, entityId, key, {
        en: { label: 'Priority', description: 'How urgent it is', 'options.high.label': 'High' },
      });
      expect(translated.status(), 'PUT translation 200').toBe(200);

      const english = await readDefinitionField(request, token, entityId, key, 'en');
      expect(english).toMatchObject({ label: 'Priority', description: 'How urgent it is' });
      expect(english?.options).toEqual([
        { value: 'high', label: 'High' },
        { value: 'low', label: 'Niski' },
      ]);

      const base = await readDefinitionField(request, token, entityId, key, 'pl');
      expect(base).toMatchObject({ label: 'Priorytet', description: 'Jak pilne' });
      expect(base?.options).toEqual([
        { value: 'high', label: 'Wysoki' },
        { value: 'low', label: 'Niski' },
      ]);

      expect((await readDefinitionField(request, token, entityId, key, 'de'))?.label, 'locale without translation').toBe('Priorytet');
      expect((await readDefinitionField(request, token, entityId, key, 'en'))?.label, 'cached read keeps the translation').toBe('Priority');
      expect((await readDefinitionField(request, token, entityId, key, 'pl'))?.label, 'cached read keeps the base value').toBe('Priorytet');
    } finally {
      await deleteFieldDefinitionTranslationIfExists(request, token, entityId, key);
      await deleteCustomEntityIfExists(request, token, entityId);
    }
  });
});
