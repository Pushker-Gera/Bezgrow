"use client"

import type { FormEvent } from "react"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"

export default function ResetPasswordPage() {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    async function recoverSessionFromUrl() {
      if (!navigator.onLine) {
        setError("Internet required to reset your password.")
        return
      }

      const url = new URL(window.location.href)
      const code = url.searchParams.get("code")
      const accessToken = url.hash ? new URLSearchParams(url.hash.slice(1)).get("access_token") : null
      const refreshToken = url.hash ? new URLSearchParams(url.hash.slice(1)).get("refresh_token") : null

      if (code) {
        setNotice("Verifying password reset link...")
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
        if (exchangeError) {
          setNotice("")
          setError(exchangeError.message)
          return
        }

        window.history.replaceState({}, "", "/reset-password")
        setNotice("Reset link verified. Choose a new password.")
        return
      }

      if (accessToken && refreshToken) {
        setNotice("Verifying password reset link...")
        const { error: sessionError } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        })
        if (sessionError) {
          setNotice("")
          setError(sessionError.message)
          return
        }

        window.history.replaceState({}, "", "/reset-password")
        setNotice("Reset link verified. Choose a new password.")
      }
    }

    void recoverSessionFromUrl()
  }, [])

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setNotice("")

    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
      setError("Password must be at least 8 characters and include a letter and number.")
      return
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }

    if (!navigator.onLine) {
      setError("Internet required to reset your password.")
      return
    }

    setLoading(true)
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setLoading(false)

    if (updateError) {
      setError(updateError.message)
      return
    }

    setNotice("Password updated successfully. Redirecting to login...")
    setTimeout(() => router.replace("/login"), 1200)
  }

  return (
    <div className="inventory-grid-bg flex min-h-dvh items-center justify-center px-3 py-5 text-white sm:px-5 sm:py-8">
      <form onSubmit={resetPassword} className="w-full max-w-md rounded-[22px] border border-white/10 bg-neutral-950/85 p-5 shadow-[0_28px_120px_rgba(0,0,0,0.45)] backdrop-blur-xl sm:rounded-[28px] sm:p-8">
        <h1 className="mb-2 text-2xl font-bold sm:text-3xl">Reset Password</h1>
        <p className="mb-5 text-sm leading-6 text-gray-400 sm:mb-6">Choose a new password for your Bezgrow account.</p>

        {error && <div className="mb-4 rounded border border-red-500/60 bg-red-950/70 p-3 text-sm text-red-200">{error}</div>}
        {notice && <div className="mb-4 rounded border border-green-600 bg-green-900 p-3 text-sm text-green-300">{notice}</div>}

        <label className="mb-4 block">
          <span className="mb-2 block text-sm text-gray-400">New password</span>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} className="min-h-12 w-full rounded-lg border border-gray-700 bg-black p-3 outline-none focus:border-cyan-300" />
        </label>

        <label className="mb-6 block">
          <span className="mb-2 block text-sm text-gray-400">Confirm password</span>
          <input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="min-h-12 w-full rounded-lg border border-gray-700 bg-black p-3 outline-none focus:border-cyan-300" />
        </label>

        <button type="submit" disabled={loading} className="min-h-12 w-full rounded-lg bg-white py-3 font-semibold text-black disabled:opacity-50">
          {loading ? "Updating..." : "Update Password"}
        </button>
      </form>
    </div>
  )
}
