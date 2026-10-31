-- Mise 2.0 db fix loop 3, item 7 (Engineer E7): clients never see profile or
-- account uuids.
--
-- Before: authenticated held select on every column of docs, plates and
-- recipes, so a housemate read profile_id, household_id and updated_by (an
-- auth uid) on rows the policies let them see, against "clients never see
-- profile uuids". The adapter (app/lib/backend/supabase-adapter.js) reads
-- path, data, rev, legacy_sha (recipes: id, staging) by name and plates only
-- through plate_for, so column grants close it without a view.
--
-- Now authenticated may select only the columns below. RLS still decides the
-- rows (policy expressions may use the hidden columns). A `select *` by a
-- client is refused (42501). Direct update was revoked by the fix3 docs door
-- file (E3), which also closes the rev-less last-write-wins update (E7).
revoke select on public.docs, public.plates, public.recipes from authenticated;
grant select (path, doc_id, kind, data, rev, legacy_sha, updated_at) on public.docs to authenticated;
grant select (data, rev, content_hash, legacy_sha) on public.plates to authenticated;
grant select (id, doc_id, data, staging, rev, legacy_sha, updated_at) on public.recipes to authenticated;
