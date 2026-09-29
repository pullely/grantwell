// The directory the portfolio reads across contexts, over the service binding
// to membership-worker: which organizations a user is in, and which users (with
// their addresses) are in two or more. Every call fails closed — `null` — and
// the caller decides what that means.

export interface OrgFact {
  /** Organization UUID. */
  orgId: string;
  name: string;
  slug: string;
}

export interface MultiOrgSubject {
  subjectId: string;
  subjectType: string;
  email: string;
  organizations: OrgFact[];
}

async function postJson<T>(worker: Fetcher, url: string, body: unknown, requestId: string, key: string): Promise<T | null> {
  let response: Response;
  try {
    response = await worker.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    const parsed = (await response.json()) as { data?: Record<string, unknown> };
    const value = parsed?.data?.[key];
    return Array.isArray(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

/** Every active organization this subject is an active member of. */
export function fetchSubjectOrganizations(
  membership: Fetcher,
  subject: { id: string; type: string },
  requestId: string,
): Promise<OrgFact[] | null> {
  return postJson<OrgFact[]>(
    membership,
    "http://membership-worker/v1/internal/membership/subject-organizations",
    { subject },
    requestId,
    "organizations",
  );
}

/** Every user who is an active member of `minOrganizations` or more active organizations. */
export function fetchMultiOrgSubjects(
  membership: Fetcher,
  minOrganizations: number,
  limit: number,
  requestId: string,
): Promise<MultiOrgSubject[] | null> {
  return postJson<MultiOrgSubject[]>(
    membership,
    "http://membership-worker/v1/internal/membership/multi-org-subjects",
    { minOrganizations, limit },
    requestId,
    "subjects",
  );
}
