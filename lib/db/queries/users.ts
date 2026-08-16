import { db, schema } from "@/lib/db/client";
import { eq } from "drizzle-orm";

const { users, orgs, orgMembers, orgSettings, projects, projectMembers } = schema;

export type BootstrappedUser = {
  userId: string;
  orgId: string;
  isNewOrg: boolean;
};

/**
 * First-time-user bootstrap. Idempotent.
 *
 * Called from the auth callback right after `exchangeCodeForSession`. Creates:
 *   - `users` row mirroring auth.users (id, email)
 *   - `orgs` row with a slug derived from email
 *   - `org_members` row (owner)
 *   - `org_settings` row with MYR / Asia/Kuala_Lumpur defaults
 *
 * If the user already exists, returns the existing org id.
 */
export async function bootstrapUser(opts: {
  authUserId: string;
  email: string;
  fullName?: string | null;
  avatarUrl?: string | null;
}): Promise<BootstrappedUser> {
  // Already bootstrapped?
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, opts.authUserId))
    .limit(1);
  if (existing.length > 0) {
    const member = await db
      .select({ orgId: orgMembers.orgId })
      .from(orgMembers)
      .where(eq(orgMembers.userId, opts.authUserId))
      .limit(1);
    if (member.length > 0) {
      return { userId: opts.authUserId, orgId: member[0].orgId, isNewOrg: false };
    }
    // User row exists but no org — fall through and create one.
  }

  // Reserve a unique slug before opening the transaction so we don't have
  // to thread the tx-typed db handle through a helper.
  const slug = await reserveSlug(slugFromEmail(opts.email));

  return db.transaction(async (tx) => {
    if (existing.length === 0) {
      await tx.insert(users).values({
        id: opts.authUserId,
        email: opts.email,
        fullName: opts.fullName ?? null,
        avatarUrl: opts.avatarUrl ?? null,
      });
    }

    const orgName = humanNameFromEmail(opts.email);
    const [org] = await tx
      .insert(orgs)
      .values({
        name: `${orgName}'s Workspace`,
        slug,
        currency: "MYR",
        timezone: "Asia/Kuala_Lumpur",
      })
      .returning({ id: orgs.id });

    await tx.insert(orgMembers).values({
      orgId: org.id,
      userId: opts.authUserId,
      role: "owner",
    });

    await tx.insert(orgSettings).values({
      orgId: org.id,
    });

    // Default project so the app always has somewhere to land. The user can
    // rename or archive it once they create their own projects.
    const [defaultProject] = await tx
      .insert(projects)
      .values({
        orgId: org.id,
        name: "Default Project",
        slug: "default",
        description:
          "Auto-created on first sign-in. Rename or archive once you've set up your real projects.",
        createdBy: opts.authUserId,
      })
      .returning({ id: projects.id });
    await tx.insert(projectMembers).values({
      projectId: defaultProject.id,
      userId: opts.authUserId,
      role: "admin",
    });

    return { userId: opts.authUserId, orgId: org.id, isNewOrg: true };
  });
}

function slugFromEmail(email: string): string {
  return (
    email
      .split("@")[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workspace"
  );
}

function humanNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "user";
  return local.charAt(0).toUpperCase() + local.slice(1);
}

async function reserveSlug(base: string): Promise<string> {
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? base : `${base}-${randomSuffix()}`;
    const hit = await db
      .select({ id: orgs.id })
      .from(orgs)
      .where(eq(orgs.slug, candidate))
      .limit(1);
    if (hit.length === 0) return candidate;
  }
  return `${base}-${randomSuffix()}-${randomSuffix()}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}
