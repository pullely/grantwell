import { GRANT_UPLOAD_CONTENT_TYPES, GRANT_UPLOAD_MAX_BYTES } from "@saas/contracts/grant";
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { allowed } from "../authz.js";
import { recordAudit } from "../audit.js";
import { nowIso, openDb } from "../context.js";
import { errorResponse, notFound, successResponse, unavailable, validationError } from "../http.js";
import { sha256Hex } from "../digest.js";
import { actorSubjectUuid, documentPublicId, grantPublicId } from "../ids.js";
import { toPublicDocument } from "../present.js";
import { parseDocumentKind, sanitizeFilename } from "../validate.js";

function tooLarge(requestId: string): Response {
  return errorResponse("validation_failed", "Files are limited to 20 MB", 413, requestId);
}

/**
 * Store a document — the award letter first — against a grant. The body is the
 * file itself; the worker hashes it, puts it in R2 under a key no second upload
 * can reuse, then records the row. Documents are immutable.
 */
export async function handleUploadDocument(
  request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  grantId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const kind = parseDocumentKind(url.searchParams.get("kind"));
  if (!kind) return validationError(requestId, { kind: ["One of award_letter, report, other"] });
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!(GRANT_UPLOAD_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    return errorResponse(
      "unsupported",
      `Upload a PDF, Word document, PNG or JPEG (got ${contentType || "no content type"})`,
      415,
      requestId,
    );
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > GRANT_UPLOAD_MAX_BYTES) return tooLarge(requestId);
  if (!(await allowed(env, actor, orgId, "grant.write", requestId))) return notFound(requestId);

  const db = openDb(env);
  if (!db || !env.GRANT_DOCS) {
    await db?.dispose();
    return unavailable(requestId);
  }
  try {
    const grant = await db.grants.getGrant(orgId, grantId);
    if (!grant) return notFound(requestId);

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) return validationError(requestId, { body: ["The file is empty"] });
    if (bytes.byteLength > GRANT_UPLOAD_MAX_BYTES) return tooLarge(requestId);

    const sha256 = await sha256Hex(bytes);
    const documentId = crypto.randomUUID();
    const objectKey = `orgs/${orgId}/grants/${grantId}/${documentId}`;
    const filename = sanitizeFilename(request.headers.get("x-filename") ?? url.searchParams.get("filename"));

    await env.GRANT_DOCS.put(objectKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: { sha256, grantId: grantPublicId(grantId), kind, filename },
    });

    const now = nowIso();
    const doc = await db.grants.createDocument({
      id: documentId,
      orgId,
      grantId,
      kind,
      objectKey,
      filename,
      contentType,
      byteSize: bytes.byteLength,
      sha256,
      uploadedBy: actorSubjectUuid(actor.subjectId),
      uploadedAt: now,
    });

    await recordAudit(db.executor, {
      type: "grant.document.uploaded",
      orgId,
      actor: { type: actor.subjectType, id: actor.subjectId },
      requestId,
      subjectKind: "grant",
      subjectId: grant.id,
      subjectName: grant.title,
      description: `Uploaded ${kind === "award_letter" ? "the award letter" : "a document"} ${filename} to "${grant.title}"`,
      payload: {
        grantId: grantPublicId(grant.id),
        documentId: documentPublicId(doc.id),
        kind,
        byteSize: doc.byteSize,
        sha256,
      },
      occurredAt: now,
    });

    return successResponse({ document: toPublicDocument(doc) }, requestId, 201);
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}

/** Stream a stored document out of R2 to a member of the grant's organization. */
export async function handleGetDocument(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  grantId: string,
  documentId: string,
): Promise<Response> {
  if (!(await allowed(env, actor, orgId, "grant.read", requestId))) return notFound(requestId);
  const db = openDb(env);
  if (!db || !env.GRANT_DOCS) {
    await db?.dispose();
    return unavailable(requestId);
  }
  try {
    const doc = await db.grants.getDocument(orgId, grantId, documentId);
    if (!doc) return notFound(requestId);
    const object = await env.GRANT_DOCS.get(doc.objectKey);
    if (!object) return notFound(requestId);
    return new Response(object.body, {
      status: 200,
      headers: {
        "content-type": doc.contentType,
        "content-length": String(doc.byteSize),
        "content-disposition": `inline; filename="${doc.filename}"`,
        "x-content-sha256": doc.sha256,
        "cache-control": "private, no-store",
      },
    });
  } catch {
    return unavailable(requestId);
  } finally {
    await db.dispose();
  }
}
