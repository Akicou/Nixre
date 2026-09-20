-- 029_deployment_superseded.sql — a deployment stops being live when it is
-- replaced.
--
-- The release swap set the new deployment to 'live' and moved
-- deploy_services.current_deployment_id, but never changed the row it replaced.
-- Every deployment a service had ever released therefore stayed 'live' forever:
-- on this instance 25 of 26 rows claimed to be live while one container per
-- service was actually serving. The history read as though nothing was ever
-- replaced.

ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_status_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_status_check
  CHECK (status IN ('queued','building','releasing','live','failed','cancelled','superseded'));

-- Backfill: anything still claiming to be live that its service is not pointing
-- at was replaced at some point in the past.
UPDATE deployments d
   SET status = 'superseded'
  FROM deploy_services s
 WHERE d.service_id = s.id
   AND d.status = 'live'
   AND (s.current_deployment_id IS NULL OR d.id <> s.current_deployment_id);
