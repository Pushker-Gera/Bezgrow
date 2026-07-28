"use client"

import { invokeTauri, isTauriRuntimeAsync } from "@/lib/desktop/tauri"

export type DesktopSavedFile = {
  path: string
  filename: string
  bytes: number
}

export type CsvColumn<Row> = {
  header: string
  value: keyof Row | ((row: Row) => unknown)
  preserveLeadingZeros?: boolean
}

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string
    types: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<{
    name?: string
    createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>
  }>
}

const encoder = new TextEncoder()
const CSV_BOM = new Uint8Array([0xef, 0xbb, 0xbf])
const FORMULA_PREFIX = /^[=+\-@]/
const LEADING_ZERO_IDENTIFIER = /^0\d+$/

export function safeSpreadsheetText(value: unknown, preserveLeadingZeros = false) {
  let text = String(value ?? "").replace(/\u0000/g, "")
  if (FORMULA_PREFIX.test(text)) text = `'${text}`
  if (preserveLeadingZeros && LEADING_ZERO_IDENTIFIER.test(text)) text = `\t${text}`
  return text
}

export function escapeCsvCell(value: unknown, preserveLeadingZeros = false) {
  const text = safeSpreadsheetText(value, preserveLeadingZeros)
  return `"${text.replaceAll("\"", "\"\"")}"`
}

export function buildCsvText<Row>(columns: CsvColumn<Row>[], rows: Row[]) {
  const header = columns.map((column) => escapeCsvCell(column.header)).join(",")
  const body = rows.map((row) =>
    columns
      .map((column) => {
        const value = typeof column.value === "function" ? column.value(row) : row[column.value]
        return escapeCsvCell(value, column.preserveLeadingZeros)
      })
      .join(",")
  )
  return [header, ...body].join("\r\n")
}

export function buildCsvBytes<Row>(columns: CsvColumn<Row>[], rows: Row[]) {
  const csv = encoder.encode(buildCsvText(columns, rows))
  const output = new Uint8Array(CSV_BOM.length + csv.length)
  output.set(CSV_BOM)
  output.set(csv, CSV_BOM.length)
  return output
}

function browserDownload(bytes: Uint8Array, filename: string, mimeType: string) {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeType })
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = objectUrl
  link.download = filename
  link.style.display = "none"
  document.body.appendChild(link)
  link.click()
  link.remove()
  globalThis.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
  return { path: filename, filename, bytes: bytes.byteLength } satisfies DesktopSavedFile
}

export async function saveDesktopBytes(
  filename: string,
  bytes: Uint8Array,
  fileKind: "csv" | "pdf" | "json"
): Promise<DesktopSavedFile | null> {
  if (await isTauriRuntimeAsync()) {
    return invokeTauri<DesktopSavedFile | null>("desktop_save_file", {
      filename,
      bytes: Array.from(bytes),
      fileKind,
    })
  }

  const mimeType =
    fileKind === "csv"
      ? "text/csv;charset=utf-8"
      : fileKind === "json"
        ? "application/json;charset=utf-8"
        : "application/pdf"
  const pickerMimeType =
    fileKind === "csv" ? "text/csv" : fileKind === "json" ? "application/json" : "application/pdf"
  const extension = fileKind === "csv" ? ".csv" : fileKind === "json" ? ".json" : ".pdf"
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker
  if (!picker) return browserDownload(bytes, filename, mimeType)

  try {
    const handle = await picker({
      suggestedName: filename,
      types: [{
        description:
          fileKind === "csv"
            ? "CSV spreadsheet"
            : fileKind === "json"
              ? "JSON diagnostics"
              : "PDF document",
        accept: { [pickerMimeType]: [extension] },
      }],
    })
    const writable = await handle.createWritable()
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mimeType })
    await writable.write(blob)
    await writable.close()
    return { filename: handle.name || filename, bytes: bytes.byteLength, path: handle.name || filename }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null
    throw error
  }
}

export async function exportCsv<Row>(
  filename: string,
  columns: CsvColumn<Row>[],
  rows: Row[]
): Promise<DesktopSavedFile | null> {
  return saveDesktopBytes(filename, buildCsvBytes(columns, rows), "csv")
}
