import { Topbar } from "@/components/app-shell/Topbar";
import { getAppSession } from "@/lib/auth/session";
import { resolveActiveProject } from "@/lib/auth/active-project";
import {
  listRulesForProject,
  listRecentExecutionsForOrg,
} from "@/lib/db/queries/rules";
import { RuleRow } from "./RuleRow";
import { NewRuleButton } from "./NewRuleButton";
import type { RuleConditions } from "@/lib/rules/types";

export default async function RulesPage() {
  const session = await getAppSession();
  if (!session) return null;
  const active = await resolveActiveProject({
    orgId: session.orgId,
    userId: session.userId,
  });

  const rules = active
    ? await listRulesForProject({ orgId: session.orgId, projectId: active.id })
    : [];

  const recentExecs = await listRecentExecutionsForOrg({
    orgId: session.orgId,
    limit: 20,
  });


  return (
    <>
      <Topbar
        title="Automated Rules"
        subtitle={`${active?.name ?? "no project"} · ${rules.length} rules`}
        actions={<NewRuleButton activeProjectName={active?.name ?? null} />}
      />
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-8">
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/30">
          <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            Rules here are managed, not executed
          </h3>
          <ul className="mt-2 space-y-1 text-xs text-amber-900/80 dark:text-amber-200/80">
            <li>
              · <strong>No scheduler runs in this app.</strong> Live enforcement for both ad
              accounts stays in the main AI Ads Agent app, which already evaluates them at
              00:00 KL and every 5 minutes.
            </li>
            <li>
              · Two schedulers acting on the same ads would double-pause them, so this app
              deliberately registers no rule cron.
            </li>
            <li>
              · <strong>Dry run</strong> works fully — it shows what <em>would</em> be paused
              and makes no Meta write calls.
            </li>
            <li>
              · A rule you create here is a draft you can test, then mirror into the main app
              to make it live.
            </li>
          </ul>
        </div>

        <div className="flex flex-col gap-3">
          {rules.length === 0 ? (
            <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900">
              No rules here yet.{" "}
              <span className="font-medium text-blue-600">
                Click &quot;+ New Rule&quot; to draft one and dry-run it.
              </span>
            </div>
          ) : (
            rules.map((r) => (
              <RuleRow
                key={r.id}
                rule={{
                  ...r,
                  conditions: r.conditions as RuleConditions,
                }}
              />
            ))
          )}
        </div>

        {recentExecs.length > 0 ? (
          <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
            <h3 className="text-sm font-semibold">Recent executions (org-wide)</h3>
            <table className="mt-3 w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="py-1">When</th>
                  <th className="py-1">Rule</th>
                  <th className="py-1">Matched</th>
                  <th className="py-1">Actions</th>
                  <th className="py-1">Mode</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {recentExecs.map((e) => {
                  const rule = rules.find((r) => r.id === e.ruleId);
                  return (
                    <tr key={e.id}>
                      <td className="py-1.5">
                        {new Date(e.ranAt).toLocaleString("en-MY", {
                          timeZone: "Asia/Kuala_Lumpur",
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="py-1.5">{rule?.name ?? e.ruleId.slice(0, 8)}</td>
                      <td className="py-1.5">{e.matched}</td>
                      <td className="py-1.5">{e.actionsTaken}</td>
                      <td className="py-1.5">
                        {e.dryRun ? (
                          <span className="text-amber-600">dry</span>
                        ) : (
                          <span className="text-emerald-600">live</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </>
  );
}
