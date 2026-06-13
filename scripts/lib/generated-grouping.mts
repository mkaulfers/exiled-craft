import type {
  GeneratedCatalogRows,
  GeneratedSourceRows,
  ItemBaseRow,
  ItemClassGroupRow,
  ModFamilyRow,
  ModRow,
  ModTierRow,
} from './generated-model.mjs'

export function buildGeneratedCatalog(rows: GeneratedSourceRows): GeneratedCatalogRows {
  const stats = sortById(rows.stats)
  const tags = sortById(rows.tags)
  const itemClasses = sortById(rows.itemClasses)
  const mods = sortMods(rows.mods)
  const itemBases = sortItemBases(rows.itemBases)
  const modFamilies = buildModFamilies(mods, itemBases)
  const itemBaseGroups = buildItemBaseGroups(itemClasses, itemBases, modFamilies)

  return { stats, tags, itemClasses, mods, itemBases, modFamilies, itemBaseGroups }
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || 'unknown'
}

export function constantName(prefix: string, slug: string): string {
  const suffix = slug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  return `${prefix}_${suffix || 'UNKNOWN'}`
}

function buildModFamilies(mods: ModRow[], itemBases: ItemBaseRow[]): ModFamilyRow[] {
  const families = new Map<string, ModRow[]>()

  for (const mod of mods) {
    const key = modFamilyKey(mod)
    const existing = families.get(key)
    if (existing) existing.push(mod)
    else families.set(key, [mod])
  }

  return [...families.entries()]
    .map(([key, familyMods]) => buildModFamily(key, familyMods, itemBases))
    .sort((a, b) => a.key.localeCompare(b.key))
}

function buildModFamily(key: string, familyMods: ModRow[], itemBases: ItemBaseRow[]): ModFamilyRow {
  const representative = familyMods[0]!
  const tiers = familyMods.map(toModTier).sort(compareTiers)
  const supportTagIds = uniqueSorted(tiers.flatMap((tier) => tier.supportTagIds))
  const itemClassIds = inferApplicableItemClasses(supportTagIds, itemBases)
  const statIds = uniqueSorted(familyMods.flatMap((mod) => mod.stats.map((stat) => stat.statId)))
  const slug = slugify([
    representative.domain,
    representative.generationType,
    representative.modTypeName,
    statIds.join('-') || 'no-stats',
  ].join('-'))

  return {
    key,
    slug,
    domain: representative.domain,
    generationType: representative.generationType,
    modTypeName: representative.modTypeName,
    statIds,
    tiers,
    applicability: { supportTagIds, itemClassIds },
  }
}

function buildItemBaseGroups(
  itemClasses: { id: string; name: string }[],
  itemBases: ItemBaseRow[],
  modFamilies: ModFamilyRow[],
): ItemClassGroupRow[] {
  const basesByClass = groupBy(itemBases, (base) => base.itemClassId)
  const implicitFamilyKeysByModId = buildImplicitFamilyKeysByModId(modFamilies)

  return itemClasses.map((itemClass) => {
    const bases = basesByClass.get(itemClass.id) ?? []
    const implicitModFamilyKeys = uniqueSorted(
      bases.flatMap((base) => base.implicitModIds.flatMap((modId) => implicitFamilyKeysByModId.get(modId) ?? [])),
    )
    const applicableFamilies = modFamilies.filter((family) =>
      family.applicability.itemClassIds.includes(itemClass.id),
    )
    const prefixModFamilyKeys = keysForGenerationType(applicableFamilies, 'PREFIX')
    const suffixModFamilyKeys = keysForGenerationType(applicableFamilies, 'SUFFIX')
    const otherModFamilyKeys = uniqueSorted(
      applicableFamilies
        .filter((family) => family.generationType !== 'PREFIX' && family.generationType !== 'SUFFIX')
        .map((family) => family.key),
    )
    const modFamilyKeys = uniqueSorted([
      ...implicitModFamilyKeys,
      ...prefixModFamilyKeys,
      ...suffixModFamilyKeys,
      ...otherModFamilyKeys,
    ])

    return {
      slug: slugify(itemClass.id),
      itemClass,
      bases,
      implicitModFamilyKeys,
      prefixModFamilyKeys,
      suffixModFamilyKeys,
      otherModFamilyKeys,
      modFamilyKeys,
    }
  })
}

function modFamilyKey(mod: ModRow): string {
  const statSignature = mod.stats.map((stat) => stat.statId).join('+') || 'no-stats'
  return [mod.domain, mod.generationType, mod.modTypeName || 'UNKNOWN', statSignature].join('|')
}

function toModTier(mod: ModRow): ModTierRow {
  return {
    id: mod.id,
    name: mod.name,
    level: mod.level,
    maxLevel: mod.maxLevel,
    isEssenceOnly: mod.isEssenceOnly,
    stats: mod.stats,
    spawnWeights: mod.spawnWeights,
    supportTagIds: uniqueSorted(
      mod.spawnWeights
        .filter((weight) => weight.tag !== 'default' && (weight.weight === null || weight.weight > 0))
        .map((weight) => weight.tag),
    ),
  }
}

function inferApplicableItemClasses(supportTagIds: string[], itemBases: ItemBaseRow[]): string[] {
  if (supportTagIds.length === 0) return []

  const supportTags = new Set(supportTagIds)
  const itemClassIds = new Set<string>()

  for (const base of itemBases) {
    if (base.tagIds.some((tagId) => supportTags.has(tagId))) {
      itemClassIds.add(base.itemClassId)
    }
  }

  return [...itemClassIds].sort((a, b) => a.localeCompare(b))
}

function buildImplicitFamilyKeysByModId(modFamilies: ModFamilyRow[]): Map<string, string[]> {
  const keysByModId = new Map<string, string[]>()

  for (const family of modFamilies) {
    for (const tier of family.tiers) {
      const existing = keysByModId.get(tier.id)
      if (existing) existing.push(family.key)
      else keysByModId.set(tier.id, [family.key])
    }
  }

  return keysByModId
}

function keysForGenerationType(modFamilies: ModFamilyRow[], generationType: string): string[] {
  return uniqueSorted(
    modFamilies.filter((family) => family.generationType === generationType).map((family) => family.key),
  )
}

function sortById<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id))
}

function sortMods(mods: ModRow[]): ModRow[] {
  return [...mods].sort((a, b) => modFamilyKey(a).localeCompare(modFamilyKey(b)) || compareModRows(a, b))
}

function sortItemBases(itemBases: ItemBaseRow[]): ItemBaseRow[] {
  return [...itemBases].sort(
    (a, b) =>
      a.itemClassId.localeCompare(b.itemClassId) ||
      a.dropLevel - b.dropLevel ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  )
}

function compareModRows(a: ModRow, b: ModRow): number {
  return a.level - b.level || a.maxLevel - b.maxLevel || numericSuffix(a.id) - numericSuffix(b.id) || a.id.localeCompare(b.id)
}

function compareTiers(a: ModTierRow, b: ModTierRow): number {
  return a.level - b.level || a.maxLevel - b.maxLevel || numericSuffix(a.id) - numericSuffix(b.id) || a.id.localeCompare(b.id)
}

function numericSuffix(value: string): number {
  const match = value.match(/(\d+)_?$/)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()

  for (const value of values) {
    const key = keyFor(value)
    const existing = groups.get(key)
    if (existing) existing.push(value)
    else groups.set(key, [value])
  }

  return groups
}