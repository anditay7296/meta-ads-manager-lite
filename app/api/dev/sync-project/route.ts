import { NextResponse, type NextRequest } from "next/server";
import { db, schema } from "@/lib/db/client";
import { syncProject } from "@/lib/meta/sync";
import { eq } from "drizzle-orm";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (token !== process.env.DEV_SETUP_TOKEN) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const projectName = request.nextUrl.searchParams.get("project") ?? "AI 网络自由创业";

  const project = await db
    .select({ id: schema.projects.id, orgId: schema.projects.orgId, name: schema.projects.name })
    .from(schema.projects)
    .where(eq(schema.projects.name, projectName))
    .limit(1);
  if (!project[0]) {
    return NextResponse.json({ error: `Project "${projectName}" not found` }, { status: 404 });
  }

  // syncProject picks the right MetaClient per ad account from its owning
  // connection — no need to fetch a single org-wide token here.
  const result = await syncProject({
    orgId: project[0].orgId,
    projectId: project[0].id,
    datePreset: "last_7d",
  });

  return NextResponse.json({ ok: true, project: project[0].name, ...result });
}
