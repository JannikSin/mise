// Types for the vendored bundle beside this file: only what Mise calls.
// The full typings live in the package; Mise keeps to this small surface.
export function createClient(url: string, key: string, options?: Record<string, unknown>): any;
declare const supabase: { createClient: typeof createClient } & Record<string, unknown>;
export default supabase;
