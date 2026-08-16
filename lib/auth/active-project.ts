import { cookies } from "next/headers";
import { listProjectsForUser } from "@/lib/db/queries/projects";

const COOKIE = "active_project_id";

export async function getActiveProjectId(): Promise<string | null> {
  const store = await cookies();
  return store.get(COOKIE)?.value ?? null;
}

export async function setActiveProjectId(projectId: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, projectId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function clearActiveProject(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE);
}

/**
 * Resolve the active project for a user. If the cookie is missing or points
 * at a project the user can no longer see, fall back to the first project
 * they have access to.
 */
export async function resolveActiveProject(opts: {
  orgId: string;
  userId: string;
}): Promise<{ id: string; name: string; slug: string } | null> {
  const cookieId = await getActiveProjectId();
  const projects = await listProjectsForUser(opts.orgId, opts.userId);
  if (projects.length === 0) return null;
  const hit = cookieId ? projects.find((p) => p.id === cookieId) : null;
  const chosen = hit ?? projects[0];
  return { id: chosen.id, name: chosen.name, slug: chosen.slug };
}
