// ============================================================================
// OmniFlow — local admin bootstrap edge function
//
// Runs once on a FRESH local stack: creates the account named in the request
// body (email + password, email confirmed immediately) and inserts its admin
// row using the service role — bypassing RLS, the same way migration 0005
// does it, but it works whether or not the user pre-exists.
//
// Auth: the service role key (supabase/.env -> SUPABASE_SERVICE_ROLE_KEY).
// No other caller can invoke it.
//
// Usage:
//   SERVICE_KEY=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' supabase/.env | cut -d= -f2)
//   curl -X POST http://127.0.0.1:54321/functions/v1/admin-bootstrap \
//     -H "Authorization: Bearer $SERVICE_KEY" \
//     -H 'Content-Type: application/json' \
//     -d '{"email":"ichsanalir@gmail.com","password":"localadmin123"}'
//
// Idempotent: existing account -> reused; existing admin row -> no-op.
// ============================================================================

import { createClient } from '@supabase/supabase-js';

export const main: SupabaseFunction = async ({ request, env }) => {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return err('no service role key in function env');
  const caller = request.headers.get('Authorization')?.replace(/^Bearer /i, '');
  if (caller !== serviceKey) return err('forbidden: only the service role may call this', 401);

  const body = await request.json().catch(() => null);
  const email: string = body?.email;
  const password: string = body?.password;
  if (!email || !password || password.length < 6) {
    return err('expected {email, password} with a >=6 char password', 400);
  }

  const admin = createClient(env.SUPABASE_URL!, serviceKey, { auth: { persistSession: false } });

  // Create (or reuse) the admin account.
  let adminUser: { id: string } | undefined;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: 'Owner' },
  });
  if (created?.user) {
    adminUser = created.user;
  } else if (createErr && /already registered/i.test(createErr.message)) {
    const res = await fetch(
      `${env.SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
    );
    adminUser = (await res.json())?.[0];
  } else {
    return err(createErr?.message ?? 'could not create admin user', 500);
  }
  if (!adminUser) return err('could not resolve admin user', 500);

  // Insert admin row + directory row (service role bypasses RLS).
  const ins = await admin.from('omniflow_admins').upsert(
    { user_id: adminUser.id, created_by: adminUser.id },
    { onConflict: 'user_id', ignoreDuplicates: true },
  );
  if (ins.error) return err(ins.error.message, 500);

  await admin.from('omniflow_members').upsert(
    { user_id: adminUser.id, email, display_name: 'Owner', last_seen_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  ).then((r) => { if (r.error) console.warn('member upsert:', r.error.message); });

  return new Response(JSON.stringify({ ok: true, admin: email }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

function err(message: string, status = 500): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
