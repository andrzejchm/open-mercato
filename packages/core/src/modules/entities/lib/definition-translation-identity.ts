export const CUSTOM_FIELD_DEF_TRANSLATION_ENTITY_TYPE = 'entities:custom_field_def'

export const CUSTOM_FIELD_DEF_LABEL_TRANSLATION_FIELD = 'label'
export const CUSTOM_FIELD_DEF_DESCRIPTION_TRANSLATION_FIELD = 'description'

/**
 * Canonical `entity_translations.entity_id` for a custom field definition.
 *
 * Built from the owning entity id and the field key (not the definition row id) so a
 * translation survives definition re-creation and is shared by the tenant-level and
 * organization-level variants of the same field. The Translation Manager on the field
 * definitions page writes this identity; the definitions read path resolves it.
 */
export function buildCustomFieldDefTranslationRecordId(entityId: string, key: string): string {
  return `${entityId}:${key}`
}

export function buildCustomFieldOptionLabelTranslationField(optionValue: string): string {
  return `options.${optionValue}.label`
}
