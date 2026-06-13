export interface StatRow {
  id: string
  isLocal: boolean
  isWeaponLocal: boolean
}

export interface TagRow {
  id: string
  displayString: string
  name: string
}

export interface ItemClassRow {
  id: string
  name: string
}

export interface ModStatRow {
  statId: string
  min: number
  max: number
}

export interface SpawnWeightRow {
  tag: string
  weight: number | null
}

export interface ModRow {
  id: string
  name: string
  domain: string
  generationType: string
  level: number
  maxLevel: number
  isEssenceOnly: boolean
  modTypeName: string
  stats: ModStatRow[]
  spawnWeights: SpawnWeightRow[]
}

export interface ItemBaseRow {
  id: string
  name: string
  itemClassId: string
  width: number
  height: number
  dropLevel: number
  implicitModIds: string[]
  tagIds: string[]
}

export interface ModTierRow {
  id: string
  name: string
  level: number
  maxLevel: number
  isEssenceOnly: boolean
  stats: ModStatRow[]
  spawnWeights: SpawnWeightRow[]
  supportTagIds: string[]
}

export interface ModApplicabilityRow {
  supportTagIds: string[]
  itemClassIds: string[]
}

export interface ModFamilyRow {
  key: string
  slug: string
  domain: string
  generationType: string
  modTypeName: string
  statIds: string[]
  tiers: ModTierRow[]
  applicability: ModApplicabilityRow
}

export interface ItemClassGroupRow {
  slug: string
  itemClass: ItemClassRow
  bases: ItemBaseRow[]
  implicitModFamilyKeys: string[]
  prefixModFamilyKeys: string[]
  suffixModFamilyKeys: string[]
  otherModFamilyKeys: string[]
  modFamilyKeys: string[]
}

export interface GeneratedCatalogRows {
  stats: StatRow[]
  tags: TagRow[]
  itemClasses: ItemClassRow[]
  mods: ModRow[]
  itemBases: ItemBaseRow[]
  modFamilies: ModFamilyRow[]
  itemBaseGroups: ItemClassGroupRow[]
}

export interface GeneratedSourceRows {
  stats: StatRow[]
  tags: TagRow[]
  itemClasses: ItemClassRow[]
  mods: ModRow[]
  itemBases: ItemBaseRow[]
}

export type GeneratedTableName = 'stats' | 'tags' | 'itemClasses' | 'mods' | 'itemBases'

export interface ManifestTableJson {
  count: number
  checksum: string
  ids: string[]
}

export interface ManifestJson {
  schemaVersion: number
  generatedAt: string
  tables: Record<GeneratedTableName, ManifestTableJson>
}

export interface ManifestTableChange {
  added: string[]
  removed: string[]
}

export type ManifestDiff = Partial<Record<GeneratedTableName, ManifestTableChange>>