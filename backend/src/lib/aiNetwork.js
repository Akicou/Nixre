// Operator-only exceptions for local AI/STT servers. Webhooks must not use this.
export function aiNetworkPolicy() {
  return {
    allowedPrivateOrigins: String(process.env.NIXRE_AI_PRIVATE_ORIGINS || '')
      .split(',').map(origin => origin.trim()).filter(Boolean),
  };
}
