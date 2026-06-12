#!/usr/bin/env node
/**
 * import-game-data.mts
 *
 * Reads binary .datc64 tables from a Path of Exile 2 game installation and
 * generates TypeScript types + data constants under app/types/generated/.
 *
 * Usage:
 *   npm run import-data -- --game-dir "C:/Program Files (x86)/Steam/steamapps/common/Path of Exile 2"
 *
 * Re-running is safe — all generated files are overwritten cleanly.
 */

import {
  decompressSliceInBundle,
  decompressedBundleSize,
  getFileInfo,
  readIndexBundle,
} from 'pathofexile-dat/bundles.js'
import type { SchemaFile, SchemaEnumeration } from 'pathofexile-dat-schema'
import { SCHEMA_URL, SCHEMA_VERSION } from 'pathofexile-dat-schema'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseDat64, readAllRows, colSize } from './lib/dat-reader.mjs'
import type { Dat64File, ColHeader, ColType, ColValue } from './lib/dat-reader.mjs'

// ─────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────

const args = process.argv.slice(2)
const gameDirIdx = args.indexOf('--game-dir')
if (gameDirIdx === -1 || !args[gameDirIdx + 1]) {
  console.error('Usage: npm run import-data -- --game-dir <path-to-poe2>')
  console.error(
    'Example: npm run import-data -- --game-dir "C:/Program Files (x86)/Steam/steamapps/common/Path of Exile 2"',
  )
  process.exit(1)
}

const GAME_DIR: string = args[gameDirIdx + 1]!
/** PoE2 stores English data at Data/Balance/ (PoE1 uses Data/) */
const POE2_DATA_PREFIX = 'Data/Balance'
const OUTPUT_DIR = path.resolve('app/types/generated')

// ─────────────────────────────────────────────
// Game file loader
// Uses only pathofexile-dat/bundles.js (no wasm dependency).
// ─────────────────────────────────────────────

class GameLoader {
  private bundleCache = new Map<string, Uint8Array>()
  private index!: { bundlesInfo: Uint8Array; filesInfo: Uint8Array }

  private constructor(private readonly gameDir: string) {}

  static async create(gameDir: string): Promise<GameLoader> {
    const loader = new GameLoader(gameDir)
    console.log('  Reading bundle index...')
    const indexBin = await loader.readBundle('_.index.bin')
    const decompSize = decompressedBundleSize(indexBin)
    const indexData = new Uint8Array(decompSize)
    decompressSliceInBundle(indexBin, 0, indexData)
    const idx = readIndexBundle(indexData)
    loader.index = { bundlesInfo: idx.bundlesInfo, filesInfo: idx.filesInfo }
    return loader
  }

  private async readBundle(name: string): Promise<Uint8Array> {
    let cached = this.bundleCache.get(name)
    if (!cached) {
      const raw = await fs.readFile(path.join(this.gameDir, 'Bundles2', name))
      cached = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
      this.bundleCache.set(name, cached)
    }
    return cached
  }

  async getFile(virtualPath: string): Promise<Uint8Array | null> {
    const loc = getFileInfo(virtualPath, this.index.bundlesInfo, this.index.filesInfo)
    if (!loc) return null
    const bundle = await this.readBundle(loc.bundle)
    const out = new Uint8Array(loc.size)
    decompressSliceInBundle(bundle, loc.offset, out)
    return out
  }

  clearCache(): void {
    this.bundleCache.clear()
  }
}

// ─────────────────────────────────────────────
// Schema → ColHeader mapping
// ─────────────────────────────────────────────

function buildHeaderMap(
  tableName: string,
  dat: Dat64File,
  schema: SchemaFile,
): Map<string, ColHeader> {
  const sch = schema.tables.find((t) => t.name === tableName)
  if (!sch) throw new Error(`No schema entry for table "${tableName}"`)

  const map = new Map<string, ColHeader>()
  let offset = 0

  for (const col of sch.columns) {
    const type = schemaColType(col.type, col.array)
    const header: ColHeader = { offset, type }
    if (col.name) map.set(col.name, header)
    offset += colSize(type)
  }

  if (dat.rowCount > 0 && offset !== dat.rowLength) {
    console.warn(
      `  WARNING ${tableName}: schema row size ${offset}b != actual ${dat.rowLength}b. ` +
        'Schema may be out of date.',
    )
  }

  return map
}

function schemaColType(colType: string, isArray: boolean): ColType {
  const scalar = scalarColType(colType)
  if (isArray) {

    return { kind: 'array', element: scalar }
  }
  return scalar
}

type ScalarColType = Exclude<ColType, { kind: 'array' }>

function scalarColType(colType: string): ScalarColType {
  switch (colType) {
    case 'bool':       return { kind: 'bool' }
    case 'i16':        return { kind: 'int', size: 2, unsigned: false }
    case 'u16':        return { kind: 'int', size: 2, unsigned: true }
    case 'i32':        return { kind: 'int', size: 4, unsigned: false }
    case 'u32':        return { kind: 'int', size: 4, unsigned: true }
    case 'enumrow':    return { kind: 'int', size: 4, unsigned: false }
    case 'f32':        return { kind: 'float' }
    case 'string':     return { kind: 'string' }
    case 'row':        return { kind: 'key', foreign: false }
    case 'foreignrow': return { kind: 'key', foreign: true }
    default:           return { kind: 'int', size: 4, unsigned: true }
  }
}

function readCol<T extends ColValue>(
  colName: string,
  headers: Map<string, ColHeader>,
  dat: Dat64File,
): T[] {
  const header = headers.get(colName)
  if (!header) throw new Error(`Column "${colName}" not found in header map`)
  return readAllRows(header, dat) as T[]
}

// ─────────────────────────────────────────────
// Enum resolver
// ─────────────────────────────────────────────

type EnumResolver = (value: number) => string

function makeEnumResolver(schema: SchemaFile, enumName: string): EnumResolver {
  const entry = schema.enumerations.find((e) => e.name === enumName)
  if (!entry) throw new Error(`Enum "${enumName}" not in schema`)
  const { enumerators, indexing } = entry
  return (value: number): string => enumerators[value - indexing] ?? `UNKNOWN_${value}`
}

// ─────────────────────────────────────────────
// Row types
// ─────────────────────────────────────────────

interface StatRow       { id: string; isLocal: boolean; isWeaponLocal: boolean }
interface TagRow        { id: string; displayString: string; name: string }
interface ItemClassRow  { id: string; name: string }
interface ModStatRow    { statId: string; min: number; max: number }
interface SpawnWeightRow{ tag: string; weight: number }
interface ModRow {
  id: string; name: string; domain: string; generationType: string
  level: number; maxLevel: number; isEssenceOnly: boolean; modTypeName: string
  stats: ModStatRow[]; spawnWeights: SpawnWeightRow[]
}
interface ItemBaseRow {
  id: string; name: string; itemClassId: string
  width: number; height: number; dropLevel: number
  implicitModIds: string[]; tagIds: string[]
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await fs.access(path.join(GAME_DIR, 'Bundles2'))
  } catch {
    console.error(`\nError: Cannot access Bundles2/ in "${GAME_DIR}"`)
    console.error('Make sure this is your Path of Exile 2 installation directory.\n')
    process.exit(1)
  }

  console.log(`\nGame directory  : ${GAME_DIR}`)
  console.log(`Output directory: ${OUTPUT_DIR}`)

  console.log('\n[Setup] Initialising bundle loader...')
  const loader = await GameLoader.create(GAME_DIR)

  console.log('[Setup] Fetching dat schema...')
  const schemaRes = await fetch(SCHEMA_URL)
  if (!schemaRes.ok) {
    console.error('Failed to fetch schema:', schemaRes.statusText)
    process.exit(1)
  }
  const schema = (await schemaRes.json()) as SchemaFile
  if (schema.version !== SCHEMA_VERSION) {
    console.error(`Schema version mismatch: expected ${SCHEMA_VERSION}, got ${schema.version}.`)
    console.error('Run: npm install pathofexile-dat@latest pathofexile-dat-schema@latest')
    process.exit(1)
  }

  const resolveDomain  = makeEnumResolver(schema, 'ModDomains')
  const resolveGenType = makeEnumResolver(schema, 'ModGenerationType')

  async function loadDat(
    tableName: string,
  ): Promise<{ dat: Dat64File; headers: Map<string, ColHeader> }> {
    const poe2Path = `${POE2_DATA_PREFIX}/${tableName}.datc64`
    const poe1Path = `Data/${tableName}.datc64`
    let raw = await loader.getFile(poe2Path)
    if (!raw) {
      console.warn(`  (${tableName}: not at ${poe2Path}, trying ${poe1Path})`)
      raw = await loader.getFile(poe1Path)
    }
    if (!raw) throw new Error(`${tableName}.datc64 not found in game install`)
    const dat = parseDat64(raw)
    const headers = buildHeaderMap(tableName, dat, schema)
    console.log(`  ${tableName}: ${dat.rowCount} rows`)
    return { dat, headers }
  }

  // ── 1. Stats ─────────────────────────────────────────────────────────────
  console.log('\n[1/5] Stats')
  const { dat: statsDat, headers: statsH } = await loadDat('Stats')
  const statsIds           = readCol<string> ('Id',           statsH, statsDat)
  const statsIsLocal       = readCol<boolean>('IsLocal',      statsH, statsDat)
  const statsIsWeaponLocal = readCol<boolean>('IsWeaponLocal',statsH, statsDat)
  const stats: StatRow[] = statsIds.map((id, i) => ({
    id, isLocal: statsIsLocal[i]!, isWeaponLocal: statsIsWeaponLocal[i]!,
  }))
  const statsByRow = new Map<number, StatRow>(stats.map((s, i) => [i, s]))

  // ── 2. Tags ──────────────────────────────────────────────────────────────
  console.log('\n[2/5] Tags')
  const { dat: tagsDat, headers: tagsH } = await loadDat('Tags')
  const tagIds     = readCol<string>('Id',            tagsH, tagsDat)
  const tagDisplay = readCol<string>('DisplayString', tagsH, tagsDat)
  const tagNames   = readCol<string>('Name',          tagsH, tagsDat)
  const tags: TagRow[] = tagIds.map((id, i) => ({
    id, displayString: tagDisplay[i]!, name: tagNames[i]!,
  }))
  const tagsByRow = new Map<number, TagRow>(tags.map((t, i) => [i, t]))

  // ── 3. ItemClasses ───────────────────────────────────────────────────────
  console.log('\n[3/5] ItemClasses')
  const { dat: classesDat, headers: classesH } = await loadDat('ItemClasses')
  const classIds   = readCol<string>('Id',   classesH, classesDat)
  const classNames = readCol<string>('Name', classesH, classesDat)
  const itemClasses: ItemClassRow[] = classIds.map((id, i) => ({ id, name: classNames[i]! }))
  const classesByRow = new Map<number, ItemClassRow>(itemClasses.map((c, i) => [i, c]))

  // ── 4. Mods + ModType ────────────────────────────────────────────────────
  console.log('\n[4/5] Mods + ModType')
  const { dat: modTypeDat, headers: modTypeH } = await loadDat('ModType')
  const modTypeNames = readCol<string>('Name', modTypeH, modTypeDat)
  const modTypeByRow = new Map<number, string>(modTypeNames.map((n, i) => [i, n]))

  const { dat: modsDat, headers: modsH } = await loadDat('Mods')
  const modIds       = readCol<string> ('Id',                    modsH, modsDat)
  const modNames     = readCol<string> ('Name',                  modsH, modsDat)
  const modDomains   = readCol<number> ('Domain',                modsH, modsDat)
  const modGenTypes  = readCol<number> ('GenerationType',        modsH, modsDat)
  const modLevels    = readCol<number> ('Level',                 modsH, modsDat)
  const modMaxLevels = readCol<number> ('MaxLevel',              modsH, modsDat)
  const modIsEssence = readCol<boolean>('IsEssenceOnlyModifier', modsH, modsDat)
  const modTypeRefs  = readCol<number | null>('ModTypeKey',      modsH, modsDat)

  const STAT_KEY_COLS = ['StatsKey1','StatsKey2','StatsKey3','StatsKey4','StatsKey5','StatsKey6'] as const
  const STAT_MIN_COLS = ['Stat1Min', 'Stat2Min', 'Stat3Min', 'Stat4Min', 'Stat5Min', 'Stat6Min'] as const
  const STAT_MAX_COLS = ['Stat1Max', 'Stat2Max', 'Stat3Max', 'Stat4Max', 'Stat5Max', 'Stat6Max'] as const

  const statKeys = STAT_KEY_COLS.map((c) => readCol<number | null>(c, modsH, modsDat))
  const statMins = STAT_MIN_COLS.map((c) => readCol<number>(c, modsH, modsDat))
  const statMaxs = STAT_MAX_COLS.map((c) => readCol<number>(c, modsH, modsDat))
  const spawnTagRefs = readCol<(number | null)[]>('SpawnWeight_TagsKeys', modsH, modsDat)
  const spawnVals    = readCol<number[]>          ('SpawnWeight_Values',   modsH, modsDat)

  const mods: ModRow[] = modIds.map((id, i) => {
    const modStats: ModStatRow[] = []
    for (let slot = 0; slot < 6; slot++) {
      const keyRef = statKeys[slot]![i]
      if (keyRef != null) {
        const stat = statsByRow.get(keyRef)
        if (stat) modStats.push({ statId: stat.id, min: statMins[slot]![i]!, max: statMaxs[slot]![i]! })
      }
    }
    const spawnWeights: SpawnWeightRow[] = (spawnTagRefs[i] ?? []).reduce<SpawnWeightRow[]>(
      (acc, tagRef, j) => {
        if (tagRef != null) {
          const tag = tagsByRow.get(tagRef)
          if (tag) acc.push({ tag: tag.id, weight: spawnVals[i]![j]! })
        }
        return acc
      }, [])
    const modTypeRef = modTypeRefs[i]
    const modTypeName = modTypeRef != null
      ? (modTypeByRow.get(modTypeRef) ?? 'UNKNOWN') : 'UNKNOWN'
    return {
      id, name: modNames[i]!, domain: resolveDomain(modDomains[i]!),
      generationType: resolveGenType(modGenTypes[i]!),
      level: modLevels[i]!, maxLevel: modMaxLevels[i]!,
      isEssenceOnly: modIsEssence[i]!, modTypeName,
      stats: modStats, spawnWeights,
    }
  })
  const modsByRow = new Map<number, string>(modIds.map((id, i) => [i, id]))

  // ── 5. BaseItemTypes ─────────────────────────────────────────────────────
  console.log('\n[5/5] BaseItemTypes')
  loader.clearCache()
  const { dat: basesDat, headers: basesH } = await loadDat('BaseItemTypes')
  const baseIds          = readCol<string>         ('Id',               basesH, basesDat)
  const baseNames        = readCol<string>         ('Name',             basesH, basesDat)
  const baseClassRefs    = readCol<number | null>  ('ItemClassesKey',   basesH, basesDat)
  const baseWidths       = readCol<number>         ('Width',            basesH, basesDat)
  const baseHeights      = readCol<number>         ('Height',           basesH, basesDat)
  const baseDropLevels   = readCol<number>         ('DropLevel',        basesH, basesDat)
  const baseImplicitRefs = readCol<(number|null)[]>('Implicit_ModsKeys',basesH, basesDat)
  const baseTagRefs      = readCol<(number|null)[]>('TagsKeys',         basesH, basesDat)

  const itemBases: ItemBaseRow[] = baseIds.map((id, i) => {
    const classRef = baseClassRefs[i]
    const itemClass = classRef != null ? classesByRow.get(classRef) : null
    const implicitModIds = (baseImplicitRefs[i] ?? []).reduce<string[]>((acc, ref) => {
      if (ref != null) { const mod = modsByRow.get(ref); if (mod) acc.push(mod) }
      return acc
    }, [])
    const tagIds = (baseTagRefs[i] ?? []).reduce<string[]>((acc, ref) => {
      if (ref != null) { const tag = tagsByRow.get(ref); if (tag) acc.push(tag.id) }
      return acc
    }, [])
    return {
      id, name: baseNames[i]!, itemClassId: itemClass?.id ?? 'UNKNOWN',
      width: baseWidths[i]!, height: baseHeights[i]!, dropLevel: baseDropLevels[i]!,
      implicitModIds, tagIds,
    }
  })

  // ── Code generation ──────────────────────────────────────────────────────
  console.log('\n[Output] Generating TypeScript files...')
  await fs.mkdir(OUTPUT_DIR, { recursive: true })

  await genTypes(schema)
  await genStats(stats)
  await genTags(tags)
  await genItemClasses(itemClasses)
  await genMods(mods)
  await genItemBases(itemBases)
  await genIndex()

  console.log('\n✓ Import complete.')
  console.log(`  stats:        ${stats.length}`)
  console.log(`  tags:         ${tags.length}`)
  console.log(`  item classes: ${itemClasses.length}`)
  console.log(`  mods:         ${mods.length}`)
  console.log(`  item bases:   ${itemBases.length}`)
  console.log(`\n  Output: ${OUTPUT_DIR}`)
}

// ─────────────────────────────────────────────
// Code generators
// ─────────────────────────────────────────────

const REGEN_NOTE =
  '// AUTO-GENERATED — do not edit manually.\n' +
  '// Regenerate: npm run import-data -- --game-dir <path-to-poe2>\n'

async function emit(filename: string, content: string): Promise<void> {
  await fs.writeFile(path.join(OUTPUT_DIR, filename), content, 'utf8')
  console.log(`  ✓ ${filename}`)
}

const q = (v: string) => JSON.stringify(v)

async function genTypes(schema: SchemaFile): Promise<void> {
  const unionValues = (e: SchemaEnumeration) =>
    [...new Set(e.enumerators.filter((v): v is string => v !== null))]
      .map((v) => `  | ${q(v)}`)
      .join('\n')
  const modDomains  = schema.enumerations.find((e) => e.name === 'ModDomains')!
  const modGenTypes = schema.enumerations.find((e) => e.name === 'ModGenerationType')!

  await emit('types.ts', `${REGEN_NOTE}
export interface Stat {
  readonly id: string;
  readonly isLocal: boolean;
  readonly isWeaponLocal: boolean;
}

export interface Tag {
  readonly id: string;
  readonly displayString: string;
  readonly name: string;
}

export interface ItemClass {
  readonly id: string;
  readonly name: string;
}

export interface ModStat {
  readonly statId: string;
  readonly min: number;
  readonly max: number;
}

export interface SpawnWeight {
  readonly tag: string;
  readonly weight: number;
}

export interface Mod {
  readonly id: string;
  readonly name: string;
  readonly domain: ModDomain;
  readonly generationType: ModGenerationType;
  /** Minimum item level required for this mod to spawn. */
  readonly level: number;
  /** Maximum ilvl at which this mod is valid (0 = no cap). */
  readonly maxLevel: number;
  readonly isEssenceOnly: boolean;
  readonly modTypeName: string;
  readonly stats: readonly ModStat[];
  readonly spawnWeights: readonly SpawnWeight[];
}

export interface ItemBase {
  readonly id: string;
  readonly name: string;
  readonly itemClassId: string;
  readonly width: number;
  readonly height: number;
  readonly dropLevel: number;
  readonly implicitModIds: readonly string[];
  readonly tagIds: readonly string[];
}

export type ModDomain =
${unionValues(modDomains)};

export type ModGenerationType =
${unionValues(modGenTypes)};
`)
}

async function genStats(stats: StatRow[]): Promise<void> {
  const rows = stats
    .map((s) => `  { id: ${q(s.id)}, isLocal: ${s.isLocal}, isWeaponLocal: ${s.isWeaponLocal} },`)
    .join('\n')
  await emit('stats.ts', `${REGEN_NOTE}
import type { Stat } from './types.js';

export const STATS: readonly Stat[] = [
${rows}
];

export const STATS_BY_ID: ReadonlyMap<string, Stat> =
  new Map(STATS.map((s) => [s.id, s]));
`)
}

async function genTags(tags: TagRow[]): Promise<void> {
  const rows = tags
    .map((t) => `  { id: ${q(t.id)}, displayString: ${q(t.displayString)}, name: ${q(t.name)} },`)
    .join('\n')
  await emit('tags.ts', `${REGEN_NOTE}
import type { Tag } from './types.js';

export const TAGS: readonly Tag[] = [
${rows}
];

export const TAGS_BY_ID: ReadonlyMap<string, Tag> =
  new Map(TAGS.map((t) => [t.id, t]));
`)
}

async function genItemClasses(itemClasses: ItemClassRow[]): Promise<void> {
  const rows = itemClasses
    .map((c) => `  { id: ${q(c.id)}, name: ${q(c.name)} },`)
    .join('\n')
  await emit('item-classes.ts', `${REGEN_NOTE}
import type { ItemClass } from './types.js';

export const ITEM_CLASSES: readonly ItemClass[] = [
${rows}
];

export const ITEM_CLASSES_BY_ID: ReadonlyMap<string, ItemClass> =
  new Map(ITEM_CLASSES.map((c) => [c.id, c]));
`)
}

async function genMods(mods: ModRow[]): Promise<void> {
  const rows = mods.map((m) => {
    const statsLit = m.stats.length === 0 ? '[]'
      : `[${m.stats.map((st) => `{ statId: ${q(st.statId)}, min: ${st.min}, max: ${st.max} }`).join(', ')}]`
    const weightsLit = m.spawnWeights.length === 0 ? '[]'
      : `[${m.spawnWeights.map((w) => `{ tag: ${q(w.tag)}, weight: ${w.weight} }`).join(', ')}]`
    return (
      `  { id: ${q(m.id)}, name: ${q(m.name)}, domain: ${q(m.domain)}, ` +
      `generationType: ${q(m.generationType)}, level: ${m.level}, maxLevel: ${m.maxLevel}, ` +
      `isEssenceOnly: ${m.isEssenceOnly}, modTypeName: ${q(m.modTypeName)}, ` +
      `stats: ${statsLit}, spawnWeights: ${weightsLit} },`
    )
  }).join('\n')
  await emit('mods.ts', `${REGEN_NOTE}
import type { Mod } from './types.js';

export const MODS: readonly Mod[] = [
${rows}
];

export const MODS_BY_ID: ReadonlyMap<string, Mod> =
  new Map(MODS.map((m) => [m.id, m]));
`)
}

async function genItemBases(itemBases: ItemBaseRow[]): Promise<void> {
  const rows = itemBases.map((b) => {
    const implLit = b.implicitModIds.length === 0 ? '[]' : `[${b.implicitModIds.map(q).join(', ')}]`
    const tagLit  = b.tagIds.length === 0          ? '[]' : `[${b.tagIds.map(q).join(', ')}]`
    return (
      `  { id: ${q(b.id)}, name: ${q(b.name)}, itemClassId: ${q(b.itemClassId)}, ` +
      `width: ${b.width}, height: ${b.height}, dropLevel: ${b.dropLevel}, ` +
      `implicitModIds: ${implLit}, tagIds: ${tagLit} },`
    )
  }).join('\n')
  await emit('item-bases.ts', `${REGEN_NOTE}
import type { ItemBase } from './types.js';

export const ITEM_BASES: readonly ItemBase[] = [
${rows}
];

export const ITEM_BASES_BY_ID: ReadonlyMap<string, ItemBase> =
  new Map(ITEM_BASES.map((b) => [b.id, b]));
`)
}

async function genIndex(): Promise<void> {
  await emit('index.ts', `${REGEN_NOTE}
export type {
  Stat, Tag, ItemClass, ModStat, SpawnWeight, Mod, ItemBase,
  ModDomain, ModGenerationType,
} from './types.js';

export { STATS, STATS_BY_ID }                  from './stats.js';
export { TAGS, TAGS_BY_ID }                    from './tags.js';
export { ITEM_CLASSES, ITEM_CLASSES_BY_ID }    from './item-classes.js';
export { MODS, MODS_BY_ID }                    from './mods.js';
export { ITEM_BASES, ITEM_BASES_BY_ID }        from './item-bases.js';
`)
}

// ─────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error('\nFatal error:', err)
  process.exit(1)
})
