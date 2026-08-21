"use client"

import { useEffect, useRef, useState } from "react"
import type { CanonicalInvoiceDocument } from "@/lib/invoice-document"

type PdfJsModule = typeof import("pdfjs-dist")

let pdfJsPromise: Promise<PdfJsModule> | null = null

function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString()
      return pdfjs
    })
  }
  return pdfJsPromise
}

export function InvoicePdfPreview({
  artifact,
  rendering,
  error,
}: {
  artifact: CanonicalInvoiceDocument | null
  rendering: boolean
  error: string
}) {
  const pagesRef = useRef<HTMLDivElement>(null)
  const [previewError, setPreviewError] = useState("")

  useEffect(() => {
    const root = pagesRef.current
    if (!root || !artifact) return

    let active = true
    let loadingTask: ReturnType<PdfJsModule["getDocument"]> | null = null
    let pdfDocument: Awaited<ReturnType<PdfJsModule["getDocument"]>["promise"]> | null = null
    const renderTasks: Array<{ cancel: () => void }> = []
    root.replaceChildren()

    void loadPdfJs()
      .then(async (pdfjs) => {
        if (!active) return
        setPreviewError("")
        // PDF.js transfers typed arrays to its worker, so it receives a copy;
        // the authoritative artifact bytes remain intact for Save/Print/Share.
        loadingTask = pdfjs.getDocument({ data: artifact.bytes.slice() })
        pdfDocument = await loadingTask.promise
        if (!active) return
        if (pdfDocument.numPages !== artifact.pageCount) {
          throw new Error("The PDF preview page count does not match the validated invoice document.")
        }

        const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
        const displayScale = artifact.format === "thermal" ? 1.65 : 1.25
        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
          if (!active) return
          const page = await pdfDocument.getPage(pageNumber)
          const displayViewport = page.getViewport({ scale: displayScale })
          const renderViewport = page.getViewport({ scale: displayScale * pixelRatio })
          const pageShell = window.document.createElement("section")
          pageShell.className = "canonical-pdf-page"
          pageShell.setAttribute("aria-label", `Invoice PDF page ${pageNumber} of ${pdfDocument.numPages}`)
          const canvas = window.document.createElement("canvas")
          canvas.width = Math.ceil(renderViewport.width)
          canvas.height = Math.ceil(renderViewport.height)
          canvas.style.width = `${displayViewport.width}px`
          canvas.style.height = `${displayViewport.height}px`
          pageShell.appendChild(canvas)
          root.appendChild(pageShell)

          const task = page.render({
            canvas,
            viewport: renderViewport,
            background: "rgb(255,255,255)",
          })
          renderTasks.push(task)
          await task.promise
        }
      })
      .catch((nextError: unknown) => {
        if (!active || (nextError instanceof Error && nextError.name === "RenderingCancelledException")) return
        root.replaceChildren()
        setPreviewError(nextError instanceof Error ? nextError.message : "The validated invoice PDF could not be displayed.")
      })

    return () => {
      active = false
      renderTasks.forEach((task) => task.cancel())
      root.querySelectorAll("canvas").forEach((canvas) => {
        canvas.width = 0
        canvas.height = 0
      })
      root.replaceChildren()
      pdfDocument?.cleanup()
      void loadingTask?.destroy()
    }
  }, [artifact])

  const visibleError = error || previewError
  return (
    <div className="canonical-pdf-preview" aria-busy={rendering}>
      {rendering && !artifact && <div className="pdf-preview-state"><span className="pdf-preview-spinner" />Generating invoice PDF...</div>}
      {visibleError && <div className="pdf-preview-state pdf-preview-error">{visibleError}</div>}
      <div ref={pagesRef} className="canonical-pdf-pages" />
      {rendering && artifact && <div className="pdf-refresh-indicator">Updating PDF...</div>}
    </div>
  )
}
