-- 020_trim_enabled_models.sql — repair enablement rows written while the
-- backend still fell back to "empty selection = full catalog".
--
-- Two shapes carry damage from that fallback:
--   * enabled_models is empty  — arrived via uncheck-all, which used to make
--     every chat/agent picker silently show all models instead of nothing;
--   * enabled_models equals model_cache verbatim — the legacy single-profile
--     migration copied the whole fetched list into the picked subset.
--
-- Both get the same seed every newly created provider receives now:
-- default_model first, then cache order, deduped, capped at five.
-- Rows holding a real hand-picked subset (non-empty, proper subset) are left
-- untouched. Equal-to-cache rows whose whole cache fits in five entries end
-- up with the same set (possibly reordered to put the default first).

WITH targets AS (
  SELECT id,
         COALESCE(default_model, '')   AS def_model,
         model_cache
  FROM ai_providers
  WHERE jsonb_typeof(enabled_models) IS DISTINCT FROM 'array'
     OR jsonb_array_length(enabled_models) = 0
     OR enabled_models = model_cache
),
seeded AS (
  SELECT t.id,
         (
           SELECT COALESCE(jsonb_agg(elem ORDER BY pos), '[]'::jsonb)
           FROM (
             SELECT elem, pos, ROW_NUMBER() OVER (ORDER BY pos) AS rn
             FROM (
               SELECT DISTINCT ON (elem) elem, pos
               FROM (
                 SELECT 0::int AS pos, t.def_model AS elem
                 WHERE t.def_model <> ''
                 UNION ALL
                 SELECT ord::int AS pos, m AS elem
                 FROM jsonb_array_elements_text(t.model_cache)
                      WITH ORDINALITY AS c(m, ord)
               ) src
               ORDER BY elem, pos
             ) dedup
           ) ranked
           WHERE ranked.rn <= 5
         ) AS seed
  FROM targets t
)
UPDATE ai_providers p
SET enabled_models = s.seed,
    updated = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
FROM seeded s
WHERE p.id = s.id;
