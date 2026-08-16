import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "User Data Deletion — AI Ads Agent",
  description:
    "How to request deletion of your data from AI Ads Agent (Andi Claude).",
};

/**
 * Public page referenced by the Meta app's "User data deletion" setting
 * (App Settings → Basic). Meta requires a human-readable instructions page;
 * keep this route public in lib/auth/middleware.ts.
 */
export default function DataDeletionPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-16 text-zinc-800 dark:text-zinc-200">
      <h1 className="text-2xl font-semibold">User Data Deletion</h1>
      <p className="text-sm leading-6">
        AI Ads Agent (Meta app name: <strong>Andi Claude</strong>) is an
        internal advertising-operations tool operated by FunnelDuo. When you
        connect your Meta account, we store: your Meta user ID and name, the
        metadata of ad accounts, Facebook Pages and Instagram accounts you
        grant access to, advertising insights for those assets, and an
        encrypted copy of the access token you authorised.
      </p>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">How to request deletion</h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-6">
          <li>
            Email{" "}
            <a
              className="text-blue-600 underline dark:text-blue-400"
              href="mailto:andi@funnelduo.com?subject=Data%20deletion%20request"
            >
              andi@funnelduo.com
            </a>{" "}
            with the subject <em>“Data deletion request”</em>, including the
            Facebook name (or user ID) you connected with.
          </li>
          <li>
            We will delete your connection record, the encrypted access token,
            and all cached data associated with your account within{" "}
            <strong>30 days</strong>, and reply to confirm once complete.
          </li>
        </ol>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Revoke access instantly</h2>
        <p className="text-sm leading-6">
          You can also cut the app’s access yourself at any time from Facebook:{" "}
          <em>
            Settings &amp; Privacy → Settings → Business integrations (or Apps
            and websites) → Andi Claude → Remove
          </em>
          . This immediately invalidates the token we hold.
        </p>
      </section>

      <p className="text-xs text-zinc-500">
        Operator: FunnelDuo · Contact: andi@funnelduo.com
      </p>
    </main>
  );
}
