/**
 * dat-reader.mts
 *
 * Minimal dat64 reader - no wasm, no fetch, no external runtime deps.
 * Handles all column types needed by the exiled-craft import pipeline.
 *
 * dat64 binary layout:
 *   [0-3]      uint32 row count
 *   [4..sep-1] fixed section (rowCount x rowLength bytes)
 *   [sep..+7]  separator: 8 x 0xBB  <- variable section starts HERE
 *   [sep+8..]  string / array element data
 *
 * All string and array offsets stored in the fixed section are measured from
 * the separator boundary (sep), NOT from sep+8. So the variable section
 * DataView must begin AT sep, matching pathofexile-dat's readDatFile().
 *
 * In dat64 all pointers / row-refs are 64-bit slots; the active data fits
 * in uint32 so we only read the low 32 bits throughout.
 */

const NULL_ROW = 0xfefefefe

// Public types

export interface Dat64File {
  readonly rowCount: number
  readonly rowLength: number
  readonly dataVariable: Uint8Array
  readonly readerFixed: DataView
  readonly readerVariable: DataView
}

export type ColType =
  | { kind: 'bool' }
  | { kind: 'int'; size: 1 | 2 | 4; unsigned: boolean }
  | { kind: 'float' }
  | { kind: 'string' }
  | { kind: 'key'; foreign: boolean }
  | { kind: 'array'; element: ScalarColType }

export type ScalarColType = Exclude<ColType, { kind: 'array' }>

export interface ColHeader {
  offset: number
  type: ColType
}

export type ScalarValue = string | number | boolean | null
export type ColValue = ScalarValue | ScalarValue[]

// Parsing

export function parseDat64(data: Uint8Array): Dat64File {
  if (data.length < 4) throw new Error('dat64: buffer too small')

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const rowCount = view.getUint32(0, true)

  // Find the 8-byte separator 0xBB x 8
  let sepAt = -1
  outer: for (let i = 4; i <= data.length - 8; i++) {
    for (let j = 0; j < 8; j++) {
      if (data[i + j] !== 0xbb) continue outer
    }
    sepAt = i
    break
  }
  if (sepAt < 0) throw new Error('dat64: separator (0xBBx8) not found')

  const fixed    = data.subarray(4, sepAt)
  // Variable section starts AT the separator (offsets in the file include the 8 sep bytes)
  const variable = data.subarray(sepAt)
  const rowLength = rowCount > 0 ? fixed.length / rowCount : 0

  return {
    rowCount,
    rowLength,
    dataVariable:   variable,
    readerFixed:    new DataView(fixed.buffer,    fixed.byteOffset,    fixed.byteLength),
    readerVariable: new DataView(variable.buffer, variable.byteOffset, variable.byteLength),
  }
}

// Field sizes (dat64)

export function colSize(type: ColType): number {
  switch (type.kind) {
    case 'bool':   return 1
    case 'int':    return type.size
    case 'float':  return 4
    case 'string': return 8    // 64-bit offset into variable section
    case 'key':    return type.foreign ? 16 : 8
    case 'array':  return 16   // {count u64, offset u64}
  }
}

// Reading

export function readAllRows(header: ColHeader, dat: Dat64File): ColValue[] {
  const out: ColValue[] = new Array(dat.rowCount)
  for (let i = 0; i < dat.rowCount; i++) {
    out[i] = readCell(header, dat, i)
  }
  return out
}

function readCell(header: ColHeader, dat: Dat64File, rowIdx: number): ColValue {
  const base = rowIdx * dat.rowLength + header.offset
  const { type } = header

  if (type.kind === 'array') {
    const count = dat.readerFixed.getUint32(base, true)
    if (count === 0) return []
    const varOffset = dat.readerFixed.getUint32(base + 8, true)
    const elemSize  = colSize(type.element)
    const elems: ScalarValue[] = []
    for (let i = 0; i < count; i++) {
      elems.push(readScalar(type.element, dat.readerVariable, dat.dataVariable, varOffset + i * elemSize))
    }
    return elems
  }

  return readScalar(type, dat.readerFixed, dat.dataVariable, base)
}

function readScalar(
  type: ScalarColType,
  reader: DataView,
  dataVariable: Uint8Array,
  offset: number,
): ScalarValue {
  switch (type.kind) {
    case 'bool':
      return reader.getUint8(offset) !== 0

    case 'int': {
      const { size, unsigned } = type
      if (size === 4) return unsigned ? reader.getUint32(offset, true) : reader.getInt32(offset, true)
      if (size === 2) return unsigned ? reader.getUint16(offset, true) : reader.getInt16(offset, true)
      return unsigned ? reader.getUint8(offset) : reader.getInt8(offset)
    }

    case 'float':
      return reader.getFloat32(offset, true)

    case 'string': {
      const varOffset = reader.getUint32(offset, true)
      return readUTF16(dataVariable, varOffset)
    }

    case 'key': {
      const rowIdx = reader.getUint32(offset, true)
      return rowIdx === NULL_ROW ? null : rowIdx
    }

    default: {
      // Exhaustiveness guard - should never reach here
      const _never: never = type
      throw new Error(`Unhandled col type: ${JSON.stringify(_never)}`)
    }
  }
}

function readUTF16(data: Uint8Array, startOffset: number): string {
  // Strings are UTF-16LE; scan for 2 consecutive 0x00 bytes (null terminator)
  let end = startOffset
  while (end + 1 < data.length && (data[end] !== 0 || data[end + 1] !== 0)) {
    end += 2
  }
  return new TextDecoder('utf-16le').decode(data.subarray(startOffset, end))
}
