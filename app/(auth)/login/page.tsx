import Image from "next/image";
import { redirect } from "next/navigation";
import { LoginForm } from "./LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  if (process.env.AUTH_BYPASS_MODE === "true") {
    redirect("/dashboard");
  }
  const { error, next } = await searchParams;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2">
        <Image
          src="/logo.png"
          alt="AI Freedom Business"
          width={120}
          height={120}
          className="object-contain"
        />
      </div>
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="text-xs text-zinc-500">
          Use the email and password your workspace owner shared with you.
          For testing, use{" "}
          <span className="font-mono text-zinc-700 dark:text-zinc-300">
            andi@funnelduo.com
          </span>{" "}
          or{" "}
          <span className="font-mono text-zinc-700 dark:text-zinc-300">
            yewfong1963@gmail.com
          </span>
          , password is{" "}
          <span className="font-mono text-zinc-700 dark:text-zinc-300">
            demo
          </span>
          .
        </p>
      </div>
      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      ) : null}
      <LoginForm next={next} />
    </div>
  );
}
