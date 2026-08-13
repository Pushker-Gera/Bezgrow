export type KeyboardFieldDescriptor = {
  tagName: string
  type?: string
  disabled?: boolean
  readOnly?: boolean
  isContentEditable?: boolean
  enterNavigationDisabled?: boolean
  enterEmptyAdvance?: boolean
  value?: string
}

export type EnterNavigationDecision = "advance" | "native" | "ignore"

const nativeInputTypes = new Set([
  "button",
  "checkbox",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
])

export function enterNavigationDecision(field: KeyboardFieldDescriptor): EnterNavigationDecision {
  if (field.disabled || field.readOnly || field.enterNavigationDisabled) return "ignore"
  if (field.isContentEditable) return "native"

  const tagName = field.tagName.toLowerCase()
  if (tagName === "textarea") {
    return field.enterEmptyAdvance && !field.value?.trim() ? "advance" : "native"
  }
  if (tagName === "select") return "advance"
  if (tagName !== "input") return "ignore"

  return nativeInputTypes.has((field.type || "text").toLowerCase()) ? "native" : "advance"
}

export function navigationAction(currentIndex: number, fieldCount: number): "advance" | "submit" | "ignore" {
  if (currentIndex < 0 || fieldCount <= 0) return "ignore"
  return currentIndex < fieldCount - 1 ? "advance" : "submit"
}
