"use client";

import { useActionState } from "react";
import { signInWithPasswordAction, type LoginState } from "./actions";

const initial: LoginState = { ok: false, message: "" };

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(
    signInWithPasswordAction,
    initial,
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next ?? ""} />
      <div className="flex flex-col gap-1">
        <label
          htmlFor="email"
          className="text-sm text-zinc-700 dark:text-zinc-300"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@company.com"
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label
          htmlFor="password"
          className="text-sm text-zinc-700 dark:text-zinc-300"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {state.message ? (
        <p
          className={
            state.ok ? "text-xs text-emerald-600" : "text-xs text-red-600"
          }
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
