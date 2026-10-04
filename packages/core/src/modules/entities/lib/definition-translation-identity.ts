export const CUSTOM_FIELD_DEF_TRANSLATION_ENTITY_TYPE = 'entities:custom_field_def'

export function buildCustomFieldDefTranslationRecordId(entityId: string, key: string): string {
  return `${entityId}:${key}`
}
