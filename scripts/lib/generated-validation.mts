import type { GeneratedCatalogRows, GeneratedSourceRows } from './generated-model.mjs'

export function validateSourceRows(rows: GeneratedSourceRows): void {
  const issues: string[] = []

  validateIds('stats', rows.stats, issues)
  validateIds('tags', rows.tags, issues)
  validateIds('itemClasses', rows.itemClasses, issues)
  validateIds('mods', rows.mods, issues)
  validateIds('itemBases', rows.itemBases, issues)

  const statIds = new Set(rows.stats.map((stat) => stat.id))
  const tagIds = new Set(rows.tags.map((tag) => tag.id))
  const itemClassIds = new Set(rows.itemClasses.map((itemClass) => itemClass.id))
  const modIds = new Set(rows.mods.map((mod) => mod.id))

  for (const mod of rows.mods) {
    if (!Number.isFinite(mod.level)) issues.push(`mod ${mod.id} has invalid level ${mod.level}`)
    if (!Number.isFinite(mod.maxLevel)) issues.push(`mod ${mod.id} has invalid maxLevel ${mod.maxLevel}`)

    for (const stat of mod.stats) {
      if (!statIds.has(stat.statId)) issues.push(`mod ${mod.id} references missing stat ${stat.statId}`)
      if (!Number.isFinite(stat.min)) issues.push(`mod ${mod.id} stat ${stat.statId} has invalid min ${stat.min}`)
      if (!Number.isFinite(stat.max)) issues.push(`mod ${mod.id} stat ${stat.statId} has invalid max ${stat.max}`)
    }

    for (const spawnWeight of mod.spawnWeights) {
      if (!tagIds.has(spawnWeight.tag)) issues.push(`mod ${mod.id} references missing spawn tag ${spawnWeight.tag}`)
      if (spawnWeight.weight !== null && !Number.isFinite(spawnWeight.weight)) {
        issues.push(`mod ${mod.id} spawn tag ${spawnWeight.tag} has invalid weight ${spawnWeight.weight}`)
      }
    }
  }

  for (const base of rows.itemBases) {
    if (!itemClassIds.has(base.itemClassId)) {
      issues.push(`item base ${base.id} references missing item class ${base.itemClassId}`)
    }

    for (const modId of base.implicitModIds) {
      if (!modIds.has(modId)) issues.push(`item base ${base.id} references missing implicit mod ${modId}`)
    }

    for (const tagId of base.tagIds) {
      if (!tagIds.has(tagId)) issues.push(`item base ${base.id} references missing tag ${tagId}`)
    }
  }

  throwIfIssues(issues)
}

export function validateGeneratedCatalog(catalog: GeneratedCatalogRows): void {
  const issues: string[] = []
  const modFamilyKeys = new Set(catalog.modFamilies.map((family) => family.key))

  validateUniqueField('modFamilies', catalog.modFamilies, (family) => family.key, issues)
  validateUniqueField('itemBaseGroups', catalog.itemBaseGroups, (group) => group.itemClass.id, issues)

  for (const family of catalog.modFamilies) {
    if (family.tiers.length === 0) issues.push(`mod family ${family.key} has no tiers`)
  }

  for (const group of catalog.itemBaseGroups) {
    for (const familyKey of group.modFamilyKeys) {
      if (!modFamilyKeys.has(familyKey)) {
        issues.push(`item class group ${group.itemClass.id} references missing mod family ${familyKey}`)
      }
    }
  }

  throwIfIssues(issues)
}

function validateIds(scope: string, rows: { id: string }[], issues: string[]): void {
  validateUniqueField(scope, rows, (row) => row.id, issues)

  for (const row of rows) {
    if (!row.id.trim()) issues.push(`${scope} contains an empty id`)
  }
}

function validateUniqueField<T>(
  scope: string,
  rows: T[],
  valueFor: (row: T) => string,
  issues: string[],
): void {
  const seen = new Set<string>()

  for (const row of rows) {
    const value = valueFor(row)
    if (seen.has(value)) issues.push(`${scope} contains duplicate id/key ${value}`)
    else seen.add(value)
  }
}

function throwIfIssues(issues: string[]): void {
  if (issues.length === 0) return

  const shownIssues = issues.slice(0, 100).map((issue) => `  - ${issue}`).join('\n')
  const remaining = issues.length > 100 ? `\n  ...and ${issues.length - 100} more` : ''
  throw new Error(`Generated data validation failed with ${issues.length} issue(s):\n${shownIssues}${remaining}`)
}