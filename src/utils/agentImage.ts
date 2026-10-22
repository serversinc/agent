export const AGENT_IMAGE_REPOSITORY = "ghcr.io/serversinc/agent";

const AGENT_IMAGE_PATTERN = new RegExp(`^${AGENT_IMAGE_REPOSITORY.replace(/[.]/g, "\\.")}@sha256:[a-f0-9]{64}$`);

/**
 * A self-update may only pull and start the agent's own image, pinned by
 * digest. Any other registry, repository, tag-only reference or a reference
 * with extra text around the digest is rejected.
 */
export function isAllowedAgentImage(image: unknown): image is string {
  return typeof image === "string" && AGENT_IMAGE_PATTERN.test(image);
}
