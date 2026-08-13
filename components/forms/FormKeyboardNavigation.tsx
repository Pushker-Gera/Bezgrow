"use client"

import { useEffect } from "react"
import { enterNavigationDecision, navigationAction } from "@/lib/form-keyboard-navigation"

const scopeSelector = 'form, [data-enter-navigation="true"]'
const fieldSelector = [
  "input:not([type='hidden']):not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']):not([type='file']):not([type='range'])",
  "select",
  "textarea",
].join(", ")

function isVisible(element: HTMLElement) {
  if (element.hidden || element.getAttribute("aria-hidden") === "true") return false
  if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false
  const style = window.getComputedStyle(element)
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0
}

function isEditable(element: HTMLElement) {
  if (!isVisible(element) || element.tabIndex < 0) return false
  if (element.matches(":disabled, [readonly], [data-enter-navigation='false']")) return false
  return true
}

function orderedFields(scope: Element) {
  return Array.from(scope.querySelectorAll<HTMLElement>(fieldSelector))
    .filter(isEditable)
    .map((element, documentIndex) => ({ element, documentIndex, tabIndex: element.tabIndex }))
    .sort((left, right) => {
      const leftPriority = left.tabIndex > 0 ? left.tabIndex : Number.MAX_SAFE_INTEGER
      const rightPriority = right.tabIndex > 0 ? right.tabIndex : Number.MAX_SAFE_INTEGER
      return leftPriority - rightPriority || left.documentIndex - right.documentIndex
    })
    .map(({ element }) => element)
}

function primaryAction(scope: Element) {
  return Array.from(
    scope.querySelectorAll<HTMLElement>(
      "[data-enter-primary], button[type='submit'], input[type='submit']",
    ),
  ).find(isEditable)
}

export function FormKeyboardNavigation() {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.key !== "Enter" ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) return

      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const decision = enterNavigationDecision({
        tagName: target.tagName,
        type: target instanceof HTMLInputElement ? target.type : undefined,
        disabled: "disabled" in target ? Boolean(target.disabled) : false,
        readOnly: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
          ? target.readOnly
          : false,
        isContentEditable: target.isContentEditable,
        enterNavigationDisabled: target.dataset.enterNavigation === "false",
        enterEmptyAdvance: target.dataset.enterEmptyAdvance === "true",
        value: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
          ? target.value
          : undefined,
      })
      if (decision !== "advance") return

      const scope = target.closest(scopeSelector)
      if (!scope) return
      const fields = orderedFields(scope)
      const index = fields.indexOf(target)
      const action = navigationAction(index, fields.length)
      if (action === "ignore") return

      event.preventDefault()
      event.stopPropagation()

      if (action === "advance") {
        fields[index + 1]?.focus({ preventScroll: false })
        return
      }

      const primary = primaryAction(scope)
      if (!primary) return
      const form = scope instanceof HTMLFormElement ? scope : primary.closest("form")
      if (form) {
        const submitter = primary instanceof HTMLButtonElement || primary instanceof HTMLInputElement
          ? primary
          : undefined
        form.requestSubmit(submitter)
      } else {
        primary.click()
      }
    }

    document.addEventListener("keydown", handleKeyDown, true)
    return () => document.removeEventListener("keydown", handleKeyDown, true)
  }, [])

  return null
}
