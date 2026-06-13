import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { SchemaEnumeration, SchemaFile } from 'pathofexile-dat-schema'
import { constantName } from './generated-grouping.mjs'
import type {
  GeneratedCatalogRows,
  GeneratedTableName,
  ManifestDiff,
  ManifestJson,
  ManifestTableChange,
  ManifestTableJson,
} from './generated-model.mjs'

const REGEN_NOTE =
  '// AUTO-GENERATED - do not edit manually.\n' +
  '// Regenerate: npm run import-data -- --game-dir <path-to-poe2>\n'

const SMALL_TABLE_CHUNK_SIZE = 500
const MOD_FAMILY_CHUNK_SIZE = 250

export async function generateCatalogFiles(
  outputDir: string,
  schema: SchemaFile,
  catalog: GeneratedCatalogRows,
): Promise<void> {
  const previousManifest = await readPreviousManifest(outputDir)
  const manifest = buildManifest(schema.version, catalog)
  const manifestDiff = diffManifests(previousManifest, manifest)

  reportManifestDiff(manifestDiff)

  await fs.rm(outputDir, { recursive: true, force: true })
  await fs.mkdir(outputDir, { recursive: true })

  await emit(outputDir, 'types.ts', genTypes(schema))
  await genStats(outputDir, catalog)
  await genTags(outputDir, catalog)
  await emit(outputDir, 'item-classes.ts', genItemClasses(catalog))
  await genItemBaseGroups(outputDir, catalog)
  await genModFamilies(outputDir, catalog)
  await emit(outputDir, 'manifest.ts', genManifest(manifest, manifestDiff))
  await emit(outputDir, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
  await emit(outputDir, 'index.ts', genIndex())
}

function genTypes(schema: SchemaFile): string {
  const modDomains = schema.enumerations.find((entry) => entry.name === 'ModDomains')
  const modGenTypes = schema.enumerations.find((entry) => entry.name === 'ModGenerationType')
  if (!modDomains) throw new Error('Enum "ModDomains" not in schema')
  if (!modGenTypes) throw new Error('Enum "ModGenerationType" not in schema')

  return `${REGEN_NOTE}
export type StatId = string;
export type TagId = string;
export type ItemClassId = string;
export type ModId = string;
export type ItemBaseId = string;
export type ModFamilyKey = string;
export type UnknownEnumValue = \`UNKNOWN_\${number}\`;

export interface Stat {
  readonly id: StatId;
  readonly isLocal: boolean;
  readonly isWeaponLocal: boolean;
}

export interface Tag {
  readonly id: TagId;
  readonly displayString: string;
  readonly name: string;
}

export interface ItemClass {
  readonly id: ItemClassId;
  readonly name: string;
}

export interface ModStat {
  readonly statId: StatId;
  readonly min: number;
  readonly max: number;
}

export interface SpawnWeight {
  readonly tag: TagId;
  readonly weight: number | null;
}

export interface ModTier {
  readonly id: ModId;
  readonly name: string;
  readonly level: number;
  readonly maxLevel: number;
  readonly isEssenceOnly: boolean;
  readonly stats: readonly ModStat[];
  readonly spawnWeights: readonly SpawnWeight[];
  readonly supportTagIds: readonly TagId[];
}

export interface ModApplicability {
  readonly supportTagIds: readonly TagId[];
  readonly itemClassIds: readonly ItemClassId[];
}

export interface ModFamily {
  readonly key: ModFamilyKey;
  readonly slug: string;
  readonly domain: ModDomain;
  readonly generationType: ModGenerationType;
  readonly modTypeName: string;
  readonly statIds: readonly StatId[];
  readonly tiers: readonly ModTier[];
  readonly applicability: ModApplicability;
}

export interface ItemBase {
  readonly id: ItemBaseId;
  readonly name: string;
  readonly itemClassId: ItemClassId;
  readonly width: number;
  readonly height: number;
  readonly dropLevel: number;
  readonly implicitModIds: readonly ModId[];
  readonly tagIds: readonly TagId[];
}

export interface ItemClassGroup {
  readonly slug: string;
  readonly itemClass: ItemClass;
  readonly bases: readonly ItemBase[];
  readonly implicitModFamilyKeys: readonly ModFamilyKey[];
  readonly prefixModFamilyKeys: readonly ModFamilyKey[];
  readonly suffixModFamilyKeys: readonly ModFamilyKey[];
  readonly otherModFamilyKeys: readonly ModFamilyKey[];
  readonly modFamilyKeys: readonly ModFamilyKey[];
}

export type GeneratedTableName = "stats" | "tags" | "itemClasses" | "mods" | "itemBases";

export interface GeneratedManifestTable {
  readonly count: number;
  readonly checksum: string;
}

export interface GeneratedManifestTableChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export interface GeneratedManifest {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly tables: Readonly<Record<GeneratedTableName, GeneratedManifestTable>>;
  readonly changes: Partial<Record<GeneratedTableName, GeneratedManifestTableChange>>;
}

export type ModDomain =
${unionValues(modDomains)}
  | UnknownEnumValue;

export type ModGenerationType =
${unionValues(modGenTypes)}
  | UnknownEnumValue;
`
}

async function genStats(outputDir: string, catalog: GeneratedCatalogRows): Promise<void> {
  const chunks = chunk(catalog.stats, SMALL_TABLE_CHUNK_SIZE)
  const imports: string[] = []
  const constants: string[] = []

  for (const [index, stats] of chunks.entries()) {
    const chunkName = `STATS_CHUNK_${String(index + 1).padStart(3, '0')}`
    const filename = `chunk-${String(index + 1).padStart(3, '0')}.ts`
    imports.push(`import { ${chunkName} } from './chunks/${filename.replace(/\.ts$/, '.js')}';`)
    constants.push(chunkName)

    await emit(outputDir, `stats/chunks/${filename}`, `${REGEN_NOTE}
import type { Stat } from '../../types.js';

export const ${chunkName}: readonly Stat[] = ${literal(stats)};
`)
  }

  await emit(outputDir, 'stats/index.ts', `${REGEN_NOTE}
import type { Stat } from '../types.js';
${imports.join('\n')}

export const STATS: readonly Stat[] = [
${constants.map((constName) => `  ...${constName},`).join('\n')}
];

export const STATS_BY_ID: ReadonlyMap<string, Stat> =
  new Map(STATS.map((stat) => [stat.id, stat]));
`)
}

async function genTags(outputDir: string, catalog: GeneratedCatalogRows): Promise<void> {
  const chunks = chunk(catalog.tags, SMALL_TABLE_CHUNK_SIZE)
  const imports: string[] = []
  const constants: string[] = []

  for (const [index, tags] of chunks.entries()) {
    const chunkName = `TAGS_CHUNK_${String(index + 1).padStart(3, '0')}`
    const filename = `chunk-${String(index + 1).padStart(3, '0')}.ts`
    imports.push(`import { ${chunkName} } from './chunks/${filename.replace(/\.ts$/, '.js')}';`)
    constants.push(chunkName)

    await emit(outputDir, `tags/chunks/${filename}`, `${REGEN_NOTE}
import type { Tag } from '../../types.js';

export const ${chunkName}: readonly Tag[] = ${literal(tags)};
`)
  }

  await emit(outputDir, 'tags/index.ts', `${REGEN_NOTE}
import type { Tag } from '../types.js';
${imports.join('\n')}

export const TAGS: readonly Tag[] = [
${constants.map((constName) => `  ...${constName},`).join('\n')}
];

export const TAGS_BY_ID: ReadonlyMap<string, Tag> =
  new Map(TAGS.map((tag) => [tag.id, tag]));
`)
}

function genItemClasses(catalog: GeneratedCatalogRows): string {
  return `${REGEN_NOTE}
import type { ItemClass } from './types.js';

export const ITEM_CLASSES: readonly ItemClass[] = ${literal(catalog.itemClasses)};

export const ITEM_CLASSES_BY_ID: ReadonlyMap<string, ItemClass> =
  new Map(ITEM_CLASSES.map((itemClass) => [itemClass.id, itemClass]));
`
}

async function genItemBaseGroups(outputDir: string, catalog: GeneratedCatalogRows): Promise<void> {
  const groupsDir = path.join(outputDir, 'item-bases', 'classes')
  await fs.mkdir(groupsDir, { recursive: true })

  const imports: string[] = []
  const constants: string[] = []

  for (const group of catalog.itemBaseGroups) {
    const constName = constantName('ITEM_BASE_GROUP', group.slug)
    imports.push(`import { ${constName} } from './classes/${group.slug}.js';`)
    constants.push(constName)

    await emit(outputDir, `item-bases/classes/${group.slug}.ts`, `${REGEN_NOTE}
import type { ItemClassGroup } from '../../types.js';

export const ${constName}: ItemClassGroup = ${literal(group)};
`)
  }

  await emit(outputDir, 'item-bases/index.ts', `${REGEN_NOTE}
import type { ItemBase, ItemClassGroup } from '../types.js';
${imports.join('\n')}

export const ITEM_BASE_GROUPS: readonly ItemClassGroup[] = [
${constants.map((constName) => `  ${constName},`).join('\n')}
];

export const ITEM_BASE_GROUPS_BY_CLASS: ReadonlyMap<string, ItemClassGroup> =
  new Map(ITEM_BASE_GROUPS.map((group) => [group.itemClass.id, group]));

export const ITEM_BASES_BY_ID: ReadonlyMap<string, ItemBase> =
  new Map(ITEM_BASE_GROUPS.flatMap((group) => group.bases).map((base) => [base.id, base]));
`)
}

async function genModFamilies(outputDir: string, catalog: GeneratedCatalogRows): Promise<void> {
  const chunks = chunk(catalog.modFamilies, MOD_FAMILY_CHUNK_SIZE)
  const imports: string[] = []
  const constants: string[] = []

  for (const [index, families] of chunks.entries()) {
    const chunkName = `MOD_FAMILIES_CHUNK_${String(index + 1).padStart(3, '0')}`
    const filename = `chunk-${String(index + 1).padStart(3, '0')}.ts`
    imports.push(`import { ${chunkName} } from './families/${filename.replace(/\.ts$/, '.js')}';`)
    constants.push(chunkName)

    await emit(outputDir, `mods/families/${filename}`, `${REGEN_NOTE}
import type { ModFamily } from '../../types.js';

export const ${chunkName}: readonly ModFamily[] = ${literal(families)};
`)
  }

  await emit(outputDir, 'mods/index.ts', `${REGEN_NOTE}
import type { ModDomain, ModFamily, ModGenerationType } from '../types.js';
${imports.join('\n')}

export const MOD_FAMILIES: readonly ModFamily[] = [
${constants.map((constName) => `  ...${constName},`).join('\n')}
];

export const MOD_FAMILIES_BY_KEY: ReadonlyMap<string, ModFamily> =
  new Map(MOD_FAMILIES.map((family) => [family.key, family]));

export const MOD_FAMILIES_BY_DOMAIN: ReadonlyMap<ModDomain, readonly ModFamily[]> =
  groupModFamilies((family) => family.domain);

export const MOD_FAMILIES_BY_GENERATION_TYPE: ReadonlyMap<ModGenerationType, readonly ModFamily[]> =
  groupModFamilies((family) => family.generationType);

function groupModFamilies<Key extends string>(keyFor: (family: ModFamily) => Key): ReadonlyMap<Key, readonly ModFamily[]> {
  const groups = new Map<Key, ModFamily[]>();

  for (const family of MOD_FAMILIES) {
    const key = keyFor(family);
    const existing = groups.get(key);
    if (existing) existing.push(family);
    else groups.set(key, [family]);
  }

  return groups;
}
`)
}

function genManifest(manifest: ManifestJson, changes: ManifestDiff): string {
  const manifestForTs = {
    schemaVersion: manifest.schemaVersion,
    generatedAt: manifest.generatedAt,
    tables: Object.fromEntries(
      Object.entries(manifest.tables).map(([tableName, table]) => [
        tableName,
        { count: table.count, checksum: table.checksum },
      ]),
    ),
    changes,
  }

  return `${REGEN_NOTE}
import type { GeneratedManifest } from './types.js';

export const GENERATED_MANIFEST: GeneratedManifest = ${literal(manifestForTs)};
`
}

function genIndex(): string {
  return `${REGEN_NOTE}
export type {
  GeneratedManifest,
  GeneratedManifestTable,
  GeneratedManifestTableChange,
  GeneratedTableName,
  ItemBase,
  ItemBaseId,
  ItemClass,
  ItemClassGroup,
  ItemClassId,
  ModApplicability,
  ModDomain,
  ModFamily,
  ModFamilyKey,
  ModGenerationType,
  ModId,
  ModStat,
  ModTier,
  SpawnWeight,
  Stat,
  StatId,
  Tag,
  TagId,
  UnknownEnumValue,
} from './types.js';

export { STATS, STATS_BY_ID } from './stats/index.js';
export { TAGS, TAGS_BY_ID } from './tags/index.js';
export { ITEM_CLASSES, ITEM_CLASSES_BY_ID } from './item-classes.js';
export { ITEM_BASE_GROUPS, ITEM_BASE_GROUPS_BY_CLASS, ITEM_BASES_BY_ID } from './item-bases/index.js';
export {
  MOD_FAMILIES,
  MOD_FAMILIES_BY_DOMAIN,
  MOD_FAMILIES_BY_GENERATION_TYPE,
  MOD_FAMILIES_BY_KEY,
} from './mods/index.js';
export { GENERATED_MANIFEST } from './manifest.js';
`
}

function unionValues(entry: SchemaEnumeration): string {
  return [...new Set(entry.enumerators.filter((value): value is string => value !== null))]
    .map((value) => `  | ${JSON.stringify(value)}`)
    .join('\n')
}

function buildManifest(schemaVersion: number, catalog: GeneratedCatalogRows): ManifestJson {
  return {
    schemaVersion,
    generatedAt: new Date().toISOString(),
    tables: {
      stats: manifestTable(catalog.stats.map((stat) => stat.id)),
      tags: manifestTable(catalog.tags.map((tag) => tag.id)),
      itemClasses: manifestTable(catalog.itemClasses.map((itemClass) => itemClass.id)),
      mods: manifestTable(catalog.mods.map((mod) => mod.id)),
      itemBases: manifestTable(catalog.itemBases.map((base) => base.id)),
    },
  }
}

function manifestTable(ids: string[]): ManifestTableJson {
  const sortedIds = [...ids].sort((a, b) => a.localeCompare(b))
  return {
    count: sortedIds.length,
    checksum: createHash('sha256').update(sortedIds.join('\n')).digest('hex'),
    ids: sortedIds,
  }
}

function diffManifests(previousManifest: ManifestJson | null, nextManifest: ManifestJson): ManifestDiff {
  if (!previousManifest) return {}

  const diff: ManifestDiff = {}

  for (const tableName of Object.keys(nextManifest.tables) as GeneratedTableName[]) {
    const previousTable = previousManifest.tables[tableName]
    const nextTable = nextManifest.tables[tableName]
    if (!previousTable) continue

    const change = diffTable(previousTable.ids, nextTable.ids)
    if (change.added.length > 0 || change.removed.length > 0) diff[tableName] = change
  }

  return diff
}

function diffTable(previousIds: string[], nextIds: string[]): ManifestTableChange {
  const previousSet = new Set(previousIds)
  const nextSet = new Set(nextIds)
  return {
    added: nextIds.filter((id) => !previousSet.has(id)),
    removed: previousIds.filter((id) => !nextSet.has(id)),
  }
}

async function readPreviousManifest(outputDir: string): Promise<ManifestJson | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(outputDir, 'manifest.json'), 'utf8')) as ManifestJson
  } catch (error: unknown) {
    if (isFileMissing(error)) return null
    throw error
  }
}

function reportManifestDiff(diff: ManifestDiff): void {
  const changedTables = Object.entries(diff).filter(([, change]) => change.added.length > 0 || change.removed.length > 0)
  if (changedTables.length === 0) {
    console.log('  Manifest diff: no added or removed IDs')
    return
  }

  console.warn('  Manifest diff: game data IDs changed')
  for (const [tableName, change] of changedTables) {
    console.warn(`    ${tableName}: +${change.added.length} / -${change.removed.length}`)
    for (const id of change.added.slice(0, 10)) console.warn(`      + ${id}`)
    for (const id of change.removed.slice(0, 10)) console.warn(`      - ${id}`)
  }
}

async function emit(outputDir: string, filename: string, content: string): Promise<void> {
  const outputFile = path.join(outputDir, filename)
  await fs.mkdir(path.dirname(outputFile), { recursive: true })
  await fs.writeFile(outputFile, content, 'utf8')
  console.log(`  + ${filename}`)
}

function literal(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

function isFileMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}